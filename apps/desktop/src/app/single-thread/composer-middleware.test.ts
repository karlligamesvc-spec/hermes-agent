import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import {
  $mainThread,
  $threadSegmentStarts,
  MAIN_THREAD_TITLE,
  noteMainThreadClaimed,
  resetMainThreadForTest
} from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $busy, $messages, $selectedStoredSessionId, $sessions } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $botIntent, setMultiBotFlagForTest } from '@/store/single-thread-bots'

import {
  $pendingThreadClaim,
  claimCreatedThread,
  type RequestGateway,
  singleThreadSend,
  startThreadSegment
} from './composer-middleware'

const notices = vi.hoisted(() => [] as string[])

vi.mock('@/store/notifications', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  dismissNotification: vi.fn(),
  notify: vi.fn((input: { message?: string }) => {
    notices.push(String(input.message ?? ''))

    return `notice-${notices.length}`
  })
}))

type Call = { method: string; params?: Record<string, unknown> }

/** A gateway that records every call and answers compress with `compress`. */
function gateway(compress: unknown = { summary: { noop: true } }, fail: string[] = []) {
  const calls: Call[] = []

  const request = (async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params })

    if (fail.includes(method)) {
      throw new Error(`${method} failed`)
    }

    if (method === 'session.compress') {
      return compress
    }

    if (method === 'session.list') {
      return { sessions: [{ id: 'thread-root', title: MAIN_THREAD_TITLE }] }
    }

    return {}
  }) as RequestGateway

  return { calls, request }
}

const now = () => Date.now() / 1000

function message(id: string, timestamp: number): ChatMessage {
  return { id, parts: [{ text: id, type: 'text' }], role: 'user', timestamp } as ChatMessage
}

const draft = (text: string) => ({ attachments: [], text })

const send = (text: string, request: RequestGateway) =>
  singleThreadSend(
    draft(text),
    () => request,
    () => 'default'
  )

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  notices.length = 0
})

afterEach(() => {
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
  $pendingThreadClaim.set(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $messages.set([])
  $sessions.set([])
  $busy.set(false)
})

describe('hc-1014 composer middleware: the switch off', () => {
  it('passes the very same draft through and calls nothing', async () => {
    setSingleThreadFlagForTest(false)
    const { calls, request } = gateway()
    const input = draft('/new')

    expect(
      await singleThreadSend(
        input,
        () => request,
        () => 'default'
      )
    ).toBe(input)
    expect(calls).toEqual([])
    expect(notices).toEqual([])
  })
})

describe('hc-1014 composer middleware: a send that does not belong in the thread stops', () => {
  it.each([
    ['unknown', '正在打开对话，稍等一下再发。'],
    ['loading', '正在打开对话，稍等一下再发。'],
    ['error', '暂时连不上对话，消息还在输入框里，稍后再发。']
  ] as const)('while the thread is %s (fail closed: no second thread)', async (status, notice) => {
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status, tipId: null })
    const { calls, request } = gateway()

    expect(await send('你好', request)).toBeNull()
    expect(notices).toEqual([notice])
    expect(calls.map(call => call.method)).toEqual(status === 'loading' ? [] : ['session.list'])
  })

  it('from an earlier conversation', async () => {
    noteMainThreadClaimed('default', 'thread-root')
    $selectedStoredSessionId.set('older-chat')

    expect(await send('你好', gateway().request)).toBeNull()
    expect(notices).toEqual(['这是更早的对话，只能看。'])
  })

  it('from an old conversation before any thread exists', async () => {
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })
    $selectedStoredSessionId.set('older-chat')

    expect(await send('你好', gateway().request)).toBeNull()
  })

  it('from the Start draft while the found thread is opening', async () => {
    noteMainThreadClaimed('default', 'thread-root')

    expect(await send('你好', gateway().request)).toBeNull()
    expect(notices).toEqual(['正在打开对话，稍等一下再发。'])
  })
})

describe('hc-1014 composer middleware: the first message makes the thread', () => {
  it('lets the draft through and marks the session it creates for claiming', async () => {
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })
    const input = draft('帮我想 3 个选题')

    expect(
      await singleThreadSend(
        input,
        () => gateway().request,
        () => 'default'
      )
    ).toBe(input)
    expect($pendingThreadClaim.get()).toMatchObject({ profile: 'default' })
  })

  it('titles the created session as the thread', async () => {
    $pendingThreadClaim.set({ at: Date.now(), profile: 'default' })
    $activeSessionId.set('rt-new')
    const { calls, request } = gateway()

    await claimCreatedThread(request, 'stored-new')

    expect(calls).toEqual([{ method: 'session.title', params: { session_id: 'rt-new', title: MAIN_THREAD_TITLE } }])
    expect($mainThread.get()).toMatchObject({ rootId: 'stored-new', status: 'found' })
    expect($pendingThreadClaim.get()).toBeNull()
  })

  it('adopts the thread another window made when the title is already taken', async () => {
    $pendingThreadClaim.set({ at: Date.now(), profile: 'default' })
    $activeSessionId.set('rt-new')
    const { calls, request } = gateway(undefined, ['session.title'])

    await claimCreatedThread(request, 'stored-new')

    expect(calls.map(call => call.method)).toEqual(['session.title', 'session.list'])
    expect($mainThread.get()).toMatchObject({ rootId: 'thread-root', status: 'found' })
  })

  it('claims nothing without a pending first message', async () => {
    $activeSessionId.set('rt-new')
    const { calls, request } = gateway()

    await claimCreatedThread(request, 'stored-new')

    expect(calls).toEqual([])
  })
})

describe('hc-1014 composer middleware: segments of the thread', () => {
  beforeEach(() => {
    // Noon, so "minutes ago" never crosses midnight; only Date is faked, timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 22, 12, 0))
    noteMainThreadClaimed('default', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    $activeSessionId.set('rt-1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const compressCalls = (calls: Call[]) => calls.filter(call => call.method === 'session.compress')

  it('a message minutes after the last one goes straight out', async () => {
    $messages.set([message('m1', now() - 120)])
    const { calls, request } = gateway()
    const input = draft('再短一点')

    expect(
      await singleThreadSend(
        input,
        () => request,
        () => 'default'
      )
    ).toBe(input)
    expect(calls).toEqual([])
  })

  it('the first message of a new day opens a segment first, then goes out', async () => {
    const yesterday = new Date()

    yesterday.setDate(yesterday.getDate() - 1)
    $messages.set([message('m1', yesterday.getTime() / 1000)])
    const { calls, request } = gateway()

    expect(await send('早，接着昨天的', request)).toEqual(draft('早，接着昨天的'))
    expect(compressCalls(calls)).toEqual([{ method: 'session.compress', params: { session_id: 'rt-1' } }])
  })

  it('「从头来」 opens a segment that keeps only what lasts, and still sends the message', async () => {
    $messages.set([message('m1', now() - 60)])
    const { calls, request } = gateway()

    expect(await send('从头来，帮我写个新脚本', request)).toEqual(draft('从头来，帮我写个新脚本'))
    expect(compressCalls(calls)).toHaveLength(1)
    expect(String(compressCalls(calls)[0].params?.focus_topic)).toContain('从头开始')
  })

  it('/new opens a segment and sends nothing: the thread never forks', async () => {
    $messages.set([message('m1', now() - 60)])
    const { calls, request } = gateway()

    expect(await send('/new', request)).toBeNull()
    expect(compressCalls(calls)).toHaveLength(1)
    expect(notices).toContain('好，前面的我记着，从这儿重新来。')
  })

  it('/branch is refused: the one thread has no second conversation to branch into', async () => {
    const { calls, request } = gateway()

    expect(await send('/branch', request)).toBeNull()
    expect(calls).toEqual([])
    expect(notices).toEqual(['一条对话里不分叉。想换个话题，直接说「从头来」。'])
  })

  it('a failed summary still lets the message out', async () => {
    $messages.set([message('m1', now() - 7 * 3600)])
    const { calls, request } = gateway(undefined, ['session.compress'])

    expect(await send('在吗', request)).toEqual(draft('在吗'))
    expect(compressCalls(calls)).toHaveLength(1)
  })

  it('records where the segment started and waits for the rotation it causes', async () => {
    $messages.set([message('m1', now() - 7 * 3600)])
    const { request } = gateway({ removed: 12, status: 'compressed' })

    const sending = send('在吗', request)

    await vi.waitFor(() => expect(notices).toContain('正在接上之前的内容…'))
    $selectedStoredSessionId.set('thread-tip-2')

    await expect(sending).resolves.toEqual(draft('在吗'))
    const noon = new Date(2026, 9, 22, 12, 0).getTime() / 1000

    expect($threadSegmentStarts.get()).toHaveLength(1)
    expect($threadSegmentStarts.get()[0]).toBeGreaterThanOrEqual(noon)
    expect($threadSegmentStarts.get()[0]).toBeLessThan(noon + 5)
  })

  it('does not compress while a turn is running', async () => {
    $busy.set(true)
    const { calls, request } = gateway()

    expect(await startThreadSegment(request, 'idle')).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('hc-1077 a send while another assistant is being switched to', () => {
  afterEach(() => {
    setMultiBotFlagForTest(false)
    $botIntent.set(null)
    $activeGatewayProfile.set('default')
  })

  it.each([
    ['in APEX’s thread', 'thread-root'],
    ['on the empty draft the switch dropped to', null]
  ])('stays in the composer %s: the thread on hand is the previous assistant’s', async (_label, selected) => {
    setMultiBotFlagForTest(true)
    noteMainThreadClaimed('default', 'thread-root')
    $selectedStoredSessionId.set(selected)
    $botIntent.set('writer')

    const { calls, request } = gateway()

    expect(await send('标题写 3 个', request)).toBeNull()
    expect(notices).toEqual(['正在打开对话，稍等一下再发。'])
    expect(calls).toEqual([])
    expect($pendingThreadClaim.get()).toBeNull()
  })

  it('goes out once the assistant asked for is the one answering', async () => {
    setMultiBotFlagForTest(true)
    $activeGatewayProfile.set('writer')
    noteMainThreadClaimed('writer', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    $sessions.set([])
    $messages.set([message('m1', now() - 60)])

    const sent = await singleThreadSend(
      draft('标题写 3 个'),
      () => gateway().request,
      () => 'writer'
    )

    expect(sent?.text).toBe('标题写 3 个')
  })

  it('with the switch off, a pending profile change changes nothing here', async () => {
    noteMainThreadClaimed('default', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    $botIntent.set('writer')
    $sessions.set([])
    $messages.set([message('m1', now() - 60)])

    expect((await send('标题写 3 个', gateway().request))?.text).toBe('标题写 3 个')
  })
})
