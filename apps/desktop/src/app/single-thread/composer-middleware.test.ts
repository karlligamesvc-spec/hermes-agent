import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPOSER_SEND_DONE, COMPOSER_SEND_TAKEN, type ComposerMiddlewareResult } from '@/app/chat/composer/contrib'
import { setRuntimeI18nLocale } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { $heldSends, resetHeldSendsForTest } from '@/store/held-sends'
import {
  $mainThread,
  $threadSegmentStarts,
  MAIN_THREAD_TITLE,
  noteMainThreadClaimed,
  resetMainThreadForTest
} from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $busy, $gatewayState, $messages, $selectedStoredSessionId, $sessions } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $botIntent, setMultiBotFlagForTest } from '@/store/single-thread-bots'

import {
  $pendingThreadClaim,
  claimCreatedThread,
  type RequestGateway,
  SEGMENT_FOCUS,
  SEGMENT_SUMMARY_MARKER,
  type SendPlace,
  sendPlace,
  singleThreadSend,
  startThreadSegment,
  threadOpening
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

/** The words a send let through (null when it was refused or held). */
const sentText = (result: ComposerMiddlewareResult) => (result && typeof result === 'object' ? result.text : null)

const send = (text: string, request: RequestGateway) =>
  singleThreadSend(
    draft(text),
    () => request,
    () => 'default'
  )

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  $gatewayState.set('open')
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
  $gatewayState.set('idle')
  resetHeldSendsForTest()
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
    expect(compressCalls(calls)).toEqual([
      { method: 'session.compress', params: { focus_topic: SEGMENT_FOCUS.day, session_id: 'rt-1' } }
    ])
  })

  // hc-1218: the engine reads the marker as "segment boundary" (apex_overlay/segment_summary.py) and
  // asks for results and what is pending, not the old task's approach; without it the summary is the
  // mid-task checkpoint that carried 「静态图推拉、不配音」 into the next video.
  it.each([
    ['a new day', 'day', () => [message('m1', now() - 26 * 3600)], '早'],
    ['six idle hours', 'idle', () => [message('m1', now() - 7 * 3600)], '在吗'],
    ['「从头来」', 'restart', () => [message('m1', now() - 60)], '从头来，帮我写个新脚本'],
    ['/new', 'restart', () => [message('m1', now() - 60)], '/new']
  ] as const)('%s asks for the segment summary, marked as a boundary', async (_label, reason, history, text) => {
    $messages.set(history())
    const { calls, request } = gateway()

    await send(text, request)

    expect(compressCalls(calls)).toEqual([
      { method: 'session.compress', params: { focus_topic: SEGMENT_FOCUS[reason], session_id: 'rt-1' } }
    ])
    expect(SEGMENT_FOCUS[reason].startsWith(SEGMENT_SUMMARY_MARKER)).toBe(true)
  })

  it('the marker the engine looks for is the one every segment focus starts with', () => {
    expect(SEGMENT_SUMMARY_MARKER).toBe('【新的一段】')

    for (const focus of Object.values(SEGMENT_FOCUS)) {
      expect(focus.startsWith(SEGMENT_SUMMARY_MARKER)).toBe(true)
      expect(focus).toContain('不记做法')
    }
  })

  it('「从头来」 opens a segment that keeps only what lasts, and still sends the message', async () => {
    $messages.set([message('m1', now() - 60)])
    const { calls, request } = gateway()

    expect(await send('从头来，帮我写个新脚本', request)).toEqual(draft('从头来，帮我写个新脚本'))
    expect(compressCalls(calls)).toHaveLength(1)
    expect(String(compressCalls(calls)[0].params?.focus_topic)).toContain('从头开始')
  })

  // hc-1226: carried out, so the composer clears; it used to answer null (a cancel), which put `/new` back
  // into the composer a few seconds later, and sending that again folded the thread a second time.
  it.each(['/new', '/reset', ' /NEW '])(
    '%s opens a segment and sends nothing: the thread never forks, and the composer clears',
    async text => {
      $messages.set([message('m1', now() - 60)])
      const { calls, request } = gateway()

      expect(await send(text, request)).toBe(COMPOSER_SEND_DONE)
      expect(compressCalls(calls)).toHaveLength(1)
      expect(notices).toEqual(['正在接上之前的内容…', '好，前面的我记着，从这儿重新来。'])
    }
  )

  it('/new that rotates the thread is carried out once the rotation lands', async () => {
    $messages.set([message('m1', now() - 60)])
    const { calls, request } = gateway({ removed: 12, status: 'compressed' })

    const sending = send('/new', request)

    await vi.waitFor(() => expect(notices).toContain('正在接上之前的内容…'))
    $selectedStoredSessionId.set('thread-tip-2')

    await expect(sending).resolves.toBe(COMPOSER_SEND_DONE)
    expect(compressCalls(calls)).toHaveLength(1)
  })

  // hc-1226: nothing was carried out, so `/new` stays in the composer to send again, and the notice says so.
  it.each([
    ['while a reply is still running', () => $busy.set(true), [] as string[], 0],
    ['when the summary fails', () => {}, ['session.compress'], 1]
  ])('/new %s is a cancel: no segment, and the words stay', async (_label, arrange, fail, compresses) => {
    $messages.set([message('m1', now() - 60)])
    arrange()
    const { calls, request } = gateway(undefined, fail)

    expect(await send('/new', request)).toBeNull()
    expect(compressCalls(calls)).toHaveLength(compresses)
    expect(notices).not.toContain('好，前面的我记着，从这儿重新来。')
    expect(notices.at(-1)).toBe('这会儿还没法从头来，稍后再发一次。')
    expect($threadSegmentStarts.get()).toEqual([])
  })

  it('「从头来」 is a message, not a command: it goes out even when the summary fails', async () => {
    $messages.set([message('m1', now() - 60)])
    const { calls, request } = gateway(undefined, ['session.compress'])

    expect(await send('从头来，帮我写个新脚本', request)).toEqual(draft('从头来，帮我写个新脚本'))
    expect(compressCalls(calls)).toHaveLength(1)
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

  it.each([
    ['nothing to fold yet', true, { summary: { noop: true } }],
    ['the summary failed', false, null]
  ] as const)('resolves whether a segment opened: %s → %s', async (_label, opened, answer) => {
    const { request } = gateway(answer ?? undefined, answer ? [] : ['session.compress'])

    expect(await startThreadSegment(request, 'restart')).toBe(opened)
    expect($threadSegmentStarts.get()).toHaveLength(opened ? 1 : 0)
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
  ])(
    'is held for the assistant asked for %s: the thread on hand is the previous assistant’s (hc-1146)',
    async (_label, selected) => {
      setMultiBotFlagForTest(true)
      noteMainThreadClaimed('default', 'thread-root')
      $selectedStoredSessionId.set(selected)
      $botIntent.set('writer')

      const { calls, request } = gateway()

      expect(await send('标题写 3 个', request)).toBe(COMPOSER_SEND_TAKEN)
      expect($heldSends.get()).toMatchObject([{ profile: 'writer', text: '标题写 3 个' }])
      expect(notices).toEqual([])
      expect(calls).toEqual([])
      expect($pendingThreadClaim.get()).toBeNull()
    }
  )

  it('a send bound to options (a queued entry, machine text) still stays where it came from', async () => {
    setMultiBotFlagForTest(true)
    noteMainThreadClaimed('default', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    $botIntent.set('writer')

    expect(
      await singleThreadSend(
        { ...draft('标题写 3 个'), bound: true },
        () => gateway().request,
        () => 'default'
      )
    ).toBeNull()
    expect(notices).toEqual(['正在打开对话，稍等一下再发。'])
    expect($heldSends.get()).toEqual([])
  })

  it('goes out once the assistant asked for is the one answering', async () => {
    setMultiBotFlagForTest(true)
    $activeGatewayProfile.set('writer')
    noteMainThreadClaimed('writer', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    // hc-1146: and its conversation is bound (loaded).
    $activeSessionId.set('rt-writer')
    $sessions.set([])
    $messages.set([message('m1', now() - 60)])

    const sent = await singleThreadSend(
      draft('标题写 3 个'),
      () => gateway().request,
      () => 'writer'
    )

    expect(sentText(sent)).toBe('标题写 3 个')
  })

  it('with the switch off, a pending profile change changes nothing here', async () => {
    noteMainThreadClaimed('default', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    $botIntent.set('writer')
    $sessions.set([])
    $messages.set([message('m1', now() - 60)])

    expect(sentText(await send('标题写 3 个', gateway().request))).toBe('标题写 3 个')
  })
})

describe('hc-1146 a send while a switched-to assistant’s conversation still loads', () => {
  afterEach(() => {
    setMultiBotFlagForTest(false)
    $activeGatewayProfile.set('default')
  })

  function onWritersThread(bound: boolean): void {
    $activeGatewayProfile.set('writer')
    noteMainThreadClaimed('writer', 'thread-root')
    $selectedStoredSessionId.set('thread-root')
    $activeSessionId.set(bound ? 'rt-writer' : null)
    $sessions.set([])
    $messages.set([message('m1', now() - 60)])
  }

  const sendAsWriter = (request: RequestGateway) =>
    singleThreadSend(
      draft('标题写 3 个'),
      () => request,
      () => 'writer'
    )

  it('is held until the conversation is bound (the composer is on screen meanwhile; hc-1146)', async () => {
    setMultiBotFlagForTest(true)
    onWritersThread(false)
    const { calls, request } = gateway()

    expect(await sendAsWriter(request)).toBe(COMPOSER_SEND_TAKEN)
    expect($heldSends.get()).toMatchObject([{ profile: 'writer', text: '标题写 3 个' }])
    expect(notices).toEqual([])
    expect(calls).toEqual([])
  })

  it('with one assistant nothing changes: the composer is hidden while loading, and a send is not held here', async () => {
    onWritersThread(false)

    expect(sentText(await sendAsWriter(gateway().request))).toBe('标题写 3 个')
    expect(notices).toEqual([])
  })
})

describe('hc-1146 where a send made now would go (one rule for the middleware and the held-send release)', () => {
  afterEach(() => {
    setMultiBotFlagForTest(false)
    $botIntent.set(null)
    $activeGatewayProfile.set('default')
  })

  type Setup = () => void

  const found = () => noteMainThreadClaimed('default', 'thread-root')

  const threadStatus = (status: 'error' | 'loading' | 'unknown' | 'absent') => () =>
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status, tipId: null })

  it.each<[string, boolean, Setup, SendPlace]>([
    ['another assistant asked for, not answering yet', true, () => (found(), $botIntent.set('writer')), 'switching'],
    ['the thread not known yet', false, threadStatus('unknown'), 'looking-up'],
    ['the lookup running', false, threadStatus('loading'), 'looking-up'],
    ['the lookup failed', false, threadStatus('error'), 'unavailable'],
    [
      'no thread yet, an old chat on screen',
      false,
      () => (threadStatus('absent')(), $selectedStoredSessionId.set('older')),
      'elsewhere'
    ],
    ['no thread yet, nothing on screen', false, threadStatus('absent'), 'new'],
    ['the thread found, not selected yet', false, found, 'selecting'],
    [
      'selected, its conversation not bound (several assistants)',
      true,
      () => (found(), $selectedStoredSessionId.set('thread-root')),
      'loading'
    ],
    [
      'selected, not bound, one assistant (its composer is hidden meanwhile)',
      false,
      () => (found(), $selectedStoredSessionId.set('thread-root')),
      'thread'
    ],
    [
      'an earlier conversation',
      false,
      () => (found(), $selectedStoredSessionId.set('older'), $activeSessionId.set('rt')),
      'elsewhere'
    ],
    [
      'the thread, bound',
      true,
      () => (found(), $selectedStoredSessionId.set('thread-root'), $activeSessionId.set('rt')),
      'thread'
    ],
    [
      'the gateway not open (the engine starting), several assistants',
      true,
      () => (
        found(),
        $selectedStoredSessionId.set('thread-root'),
        $activeSessionId.set('rt'),
        $gatewayState.set('connecting')
      ),
      'connecting'
    ],
    [
      'the gateway not open, one assistant (its composer refuses the send itself)',
      false,
      () => (
        found(),
        $selectedStoredSessionId.set('thread-root'),
        $activeSessionId.set('rt'),
        $gatewayState.set('connecting')
      ),
      'thread'
    ]
  ])('%s', (_label, multiBot, setup, place) => {
    setMultiBotFlagForTest(multiBot)
    setup()

    expect(sendPlace('default')).toBe(place)
  })

  it.each<[SendPlace, boolean]>([
    ['connecting', true],
    ['switching', true],
    ['looking-up', true],
    ['selecting', true],
    ['loading', true],
    ['unavailable', false],
    ['elsewhere', false],
    ['new', false],
    ['thread', false]
  ])('%s is an opening thread: %s', (place, opening) => {
    expect(threadOpening(place)).toBe(opening)
  })
})

describe('hc-1146 every 「正在打开对话」 exit holds a send while several assistants are on', () => {
  beforeEach(() => setMultiBotFlagForTest(true))

  afterEach(() => {
    setMultiBotFlagForTest(false)
    $botIntent.set(null)
    $activeGatewayProfile.set('default')
  })

  it.each<[string, () => void, string, string[]]>([
    [
      'connecting (the engine starting: no lookup yet)',
      () => (
        $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'unknown', tipId: null }),
        $gatewayState.set('connecting')
      ),
      'default',
      []
    ],
    ['switching', () => (noteMainThreadClaimed('default', 'thread-root'), $botIntent.set('writer')), 'writer', []],
    [
      'looking-up (unknown: the lookup starts)',
      () => $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'unknown', tipId: null }),
      'default',
      ['session.list']
    ],
    [
      'looking-up (loading)',
      () => $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'loading', tipId: null }),
      'default',
      []
    ],
    ['selecting', () => noteMainThreadClaimed('default', 'thread-root'), 'default', []],
    [
      'loading',
      () => (noteMainThreadClaimed('default', 'thread-root'), $selectedStoredSessionId.set('thread-root')),
      'default',
      []
    ]
  ])('%s: taken, held for the assistant on screen, no notice', async (_exit, setup, profile, methods) => {
    setup()
    const { calls, request } = gateway()
    const attachments = [{ id: 'a1', kind: 'image', label: 'shot.png' }] as never[]

    expect(
      await singleThreadSend(
        { attachments, text: '标题写 3 个' },
        () => request,
        () => 'default'
      )
    ).toBe(COMPOSER_SEND_TAKEN)
    expect($heldSends.get()).toMatchObject([{ attachments, profile, text: '标题写 3 个' }])
    expect(notices).toEqual([])
    expect(calls.map(call => call.method)).toEqual(methods)
  })

  it.each([
    [
      'the lookup failed',
      () => $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'error', tipId: null }),
      '暂时连不上对话，消息还在输入框里，稍后再发。'
    ],
    [
      'an earlier conversation',
      () => (
        noteMainThreadClaimed('default', 'thread-root'),
        $selectedStoredSessionId.set('older'),
        $activeSessionId.set('rt')
      ),
      '这是更早的对话，只能看。'
    ]
  ] as const)('%s is not an opening thread: refused as before, nothing held', async (_label, setup, notice) => {
    setup()

    expect(await send('标题写 3 个', gateway().request)).toBeNull()
    expect(notices).toEqual([notice])
    expect($heldSends.get()).toEqual([])
  })
})
