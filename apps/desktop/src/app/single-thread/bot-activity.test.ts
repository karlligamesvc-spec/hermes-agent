/**
 * hc-1077: a background assistant's sidebar line is folded from its own
 * session state the way the activity line folds the turn on screen, and the
 * per-profile presence helpers the rows read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { $mainThreadsByProfile, type MainThreadState, resetMainThreadForTest } from '@/store/main-thread'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botUnread, profileOfThreadStoredId, profileThread } from '@/store/single-thread-presence'
import { remixLiveTurn, remixRunningTurn } from '@/test/remix-turn'

import { backgroundActivity } from './bot-activity'

const asChat = (turn: ReturnType<typeof remixRunningTurn>): ChatMessage[] =>
  turn.map(message => ({ id: message.id, parts: message.content as ChatMessage['parts'], role: message.role }))

const state = (messages: ChatMessage[], extra: Partial<ClientSessionState> = {}) =>
  ({ busy: true, messages, needsInput: false, storedSessionId: 'w-1', ...extra }) as unknown as ClientSessionState

const processCopy = () => TRANSLATIONS.zh.assistant.tool.process

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
})

afterEach(() => {
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
})

describe('hc-1077 what a background assistant is doing', () => {
  it('names the running step in the words the activity line uses for it', () => {
    expect(backgroundActivity(state(asChat(remixRunningTurn())), processCopy())).toEqual({
      text: '正在识别语音…',
      waiting: false
    })
  })

  it.each([
    ['idle', { busy: false }],
    ['waiting on the user (the row says 等你决定 itself)', { needsInput: true }]
  ])('says nothing of its own when %s', (_label, extra) => {
    expect(backgroundActivity(state(asChat(remixRunningTurn()), extra), processCopy())).toBeNull()
  })

  it('reads only the turn in flight, not an earlier finished one', () => {
    const earlier = asChat(remixLiveTurn()).map(message => ({ ...message, id: `old-${message.id}` }))
    const running = asChat(remixRunningTurn())

    expect(backgroundActivity(state([...earlier, ...running]), processCopy())?.text).toBe('正在识别语音…')
  })

  it('has no session state for an assistant this window never opened', () => {
    expect(backgroundActivity(null, processCopy())).toBeNull()
  })
})

describe('hc-1077 per-assistant presence', () => {
  const found = (profile: string, ids: string[]): MainThreadState => ({
    ids,
    profile,
    rootId: ids[0]!,
    status: 'found',
    tipId: ids.at(-1)!
  })

  it('shows a dot only for a reply after one the user saw, never before they first looked', () => {
    expect(botUnread({ id: 'r2', line: '好了' }, 'r1')).toBe(true)
    expect(botUnread({ id: 'r1', line: '好了' }, 'r1')).toBe(false)
    expect(botUnread({ id: 'r2', line: '好了' }, undefined)).toBe(false)
    expect(botUnread(null, 'r1')).toBe(false)
  })

  it('reads the active thread for the active profile and the looked-up one for the others', () => {
    const active = found('default', ['a-1'])
    const byProfile = { default: found('default', ['stale']), writer: found('writer', ['w-1']) }

    expect(profileThread('default', active, byProfile)).toBe(active)
    expect(profileThread('writer', active, byProfile)).toBe(byProfile.writer)
    expect(profileThread('nobody', active, byProfile)).toBeUndefined()
  })

  it('finds which assistant a stored conversation belongs to, among the threads held', () => {
    $mainThreadsByProfile.set({
      default: found('default', ['a-1', 'a-2']),
      empty: { ids: [], profile: 'empty', rootId: null, status: 'absent', tipId: null },
      writer: found('writer', ['w-1'])
    })

    expect(profileOfThreadStoredId('a-2')).toBe('default')
    expect(profileOfThreadStoredId('w-1')).toBe('writer')
    expect(profileOfThreadStoredId('elsewhere')).toBeNull()
    expect(profileOfThreadStoredId(null)).toBeNull()
  })
})
