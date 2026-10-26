import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { formatUsedPercent, SINGLE_THREAD_SIDEBAR_COPY } from '@/i18n/single-thread-sidebar'
import type { ChatMessage } from '@/lib/chat-messages'

import { $mainThread, type MainThreadState, noteMainThreadClaimed, resetMainThreadForTest } from './main-thread'
import { $sessionStates } from './session-states'
import {
  $threadPresence,
  $threadUnread,
  latestReply,
  mainThreadState,
  markThreadReplySeen,
  presenceOf,
  resetThreadPresenceForTest
} from './single-thread-presence'
import { $threadActivity, $threadInCall, useThreadInCall } from './thread-signals'

const say = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  parts: [{ text, type: 'text' }],
  role,
  ...extra
})

const state = (storedSessionId: null | string, extra: Partial<ClientSessionState> = {}) =>
  ({ busy: false, messages: [], needsInput: false, storedSessionId, ...extra }) as unknown as ClientSessionState

const found = (ids: string[], tipId: string): MainThreadState => ({
  ids,
  profile: 'default',
  rootId: ids[0]!,
  status: 'found',
  tipId
})

afterEach(() => {
  resetThreadPresenceForTest()
  resetMainThreadForTest()
  $sessionStates.set({})
})

describe('hc-1061 which session is the thread', () => {
  it('is the loaded session on the thread’s lineage, the tip first', () => {
    const states = { a: state('older-chat'), b: state('thread-root'), c: state('thread-tip') }

    expect(mainThreadState(states, found(['thread-root', 'thread-tip'], 'thread-tip'))).toBe(states.c)
    expect(mainThreadState({ a: states.a, b: states.b }, found(['thread-root', 'thread-tip'], 'thread-tip'))).toBe(
      states.b
    )
    expect(mainThreadState({ a: states.a }, found(['thread-root'], 'thread-root'))).toBeNull()
  })

  it('is nothing until the thread is found', () => {
    const states = { b: state('thread-root') }

    for (const status of ['absent', 'error', 'loading', 'unknown'] as const) {
      expect(mainThreadState(states, { ...found(['thread-root'], 'thread-root'), status })).toBeNull()
    }
  })
})

describe('hc-1061 the latest reply, as one line', () => {
  it.each([
    [
      'plain text',
      [say('a1', 'assistant', '周三那条的脚本写好了，35 秒：')],
      { id: 'a1', line: '周三那条的脚本写好了，35 秒：' }
    ],
    [
      'markdown markers stripped',
      [say('a1', 'assistant', '\n## **结论**：前 3 秒有钩子\n- 第二点')],
      { id: 'a1', line: '结论：前 3 秒有钩子' }
    ],
    ['a list item', [say('a1', 'assistant', '1. 衣柜多出一半空间')], { id: 'a1', line: '衣柜多出一半空间' }],
    [
      'a number is not a list marker',
      [say('a1', 'assistant', '1.2 万比你前几条都高')],
      { id: 'a1', line: '1.2 万比你前几条都高' }
    ],
    ['nor is a minus sign', [say('a1', 'assistant', '-5% 的完播也能起量')], { id: 'a1', line: '-5% 的完播也能起量' }],
    [
      'the user’s own message is not a reply',
      [say('a1', 'assistant', '好'), say('u1', 'user', '谢谢')],
      { id: 'a1', line: '好' }
    ],
    [
      'hidden and empty replies skipped',
      [
        say('a1', 'assistant', '上一句'),
        say('a2', 'assistant', '藏起来的', { hidden: true }),
        say('a3', 'assistant', '  ')
      ],
      { id: 'a1', line: '上一句' }
    ],
    ['no reply yet', [say('u1', 'user', '你好')], null]
  ])('%s', (_label, messages, expected) => {
    expect(latestReply(messages)).toEqual(expected)
  })
})

describe('hc-1061 what the assistant row says', () => {
  const reply = { id: 'a1', line: '换好了' }
  const busy = state('t', { busy: true })

  it.each([
    ['a call wins over everything', busy, { text: '正在识别语音…', waiting: true }, true, { kind: 'call' }],
    ['the activity line waiting on the user', busy, { text: '等你决定', waiting: true }, false, { kind: 'waiting' }],
    [
      'a question parked on the thread while the conversation is off screen',
      state('t', { busy: true, needsInput: true }),
      null,
      false,
      { kind: 'waiting' }
    ],
    [
      'the step the activity line names',
      busy,
      { text: '正在识别语音…', waiting: false },
      false,
      { kind: 'working', text: '正在识别语音…' }
    ],
    ['busy with the conversation off screen: no step to name', busy, null, false, { kind: 'working', text: null }],
    ['idle: the latest reply', state('t'), null, false, { kind: 'idle', text: '换好了' }],
    ['nothing loaded yet', null, null, false, { kind: 'idle', text: '换好了' }]
  ] as const)('%s', (_label, session, activity, inCall, expected) => {
    expect(presenceOf(session, activity, inCall, reply)).toEqual(expected)
  })

  it('follows the thread’s own session state, not the session on screen', () => {
    noteMainThreadClaimed('default', 'thread-root')
    $sessionStates.set({
      other: state('older-chat', { busy: true }),
      thread: state('thread-root', { messages: [say('a1', 'assistant', '今天能拍的 3 个')] })
    })

    expect($threadPresence.get()).toEqual({ kind: 'idle', text: '今天能拍的 3 个' })
    expect($mainThread.get().status).toBe('found')
  })
})

describe('hc-1061 the unread dot', () => {
  it('appears only for a reply after one the user has seen', () => {
    noteMainThreadClaimed('default', 'thread-root')
    $sessionStates.set({ thread: state('thread-root', { messages: [say('a1', 'assistant', '第一句')] }) })

    // Never opened since launch: nothing to compare against, no dot.
    expect($threadUnread.get()).toBe(false)

    markThreadReplySeen('a1')
    expect($threadUnread.get()).toBe(false)

    $sessionStates.set({
      thread: state('thread-root', {
        messages: [say('a1', 'assistant', '第一句'), say('a2', 'assistant', '早，今天能拍的 3 个')]
      })
    })
    expect($threadUnread.get()).toBe(true)

    markThreadReplySeen('a2')
    expect($threadUnread.get()).toBe(false)
  })
})

describe('hc-1061 the call and activity atoms', () => {
  it('a call is open exactly while its panel is mounted', () => {
    const panel = renderHook(() => useThreadInCall())

    expect($threadInCall.get()).toBe(true)
    panel.unmount()
    expect($threadInCall.get()).toBe(false)
  })

  it('nothing is published until the activity line says something', () => {
    expect($threadActivity.get()).toBeNull()
  })
})

describe('hc-1061 the usage percent', () => {
  const zh = SINGLE_THREAD_SIDEBAR_COPY.zh

  it.each([
    [0, '0%'],
    [0.0004, '不到 1%'],
    [0.01, '1%'],
    [0.18, '18%'],
    [0.29, '29%'],
    [0.1899, '18%'],
    [1.25, '125%']
  ])('%s → %s', (ratio, expected) => {
    expect(formatUsedPercent(ratio, zh)).toBe(expected)
  })

  it('names the period the cloud measured', () => {
    expect(zh.planUsage({ percent: '18%', period: 'month', plan: '快速' })).toBe('快速 · 本月用了 18%')
    expect(zh.planUsage({ percent: '18%', period: 'week', plan: '快速' })).toBe('快速 · 本周用了 18%')
    expect(SINGLE_THREAD_SIDEBAR_COPY.en.planUsage({ percent: '18%', period: 'month', plan: 'Fast' })).toBe(
      'Fast · 18% used this month'
    )
  })
})
