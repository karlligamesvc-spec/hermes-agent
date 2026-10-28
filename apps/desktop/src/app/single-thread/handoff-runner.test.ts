import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { composeHandoffRequest } from '@/lib/handoff-text'
/**
 * hc-1086 (多助手二期 R1): the relay (接力) dispatcher against a fake set of
 * engines, one per assistant, each with its own 「APEX 主线」.
 */
import { $authState } from '@/store/auth'
import { MAIN_THREAD_TITLE, resetMainThreadForTest } from '@/store/main-thread'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import {
  $handoffs,
  cancelHandoffsForProfile,
  handoffById,
  type HandoffRecord,
  onHandoffReturned,
  resetHandoffsForTest,
  setHandoffDispatcher,
  setMultiBotHandoffFlagForTest,
  startHandoff,
  type StartHandoffInput,
  stopHandoff
} from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import { createHandoffRunner, type HandoffRunner, type HandoffRunnerTiming } from './handoff-runner'

const SIGNED_OUT_AUTH = $authState.get()

const TIMING: HandoffRunnerTiming = {
  missingRounds: 2,
  pollMs: 15,
  queueMs: 10,
  retryAfterMs: 300,
  settleMs: 2,
  unreachableRounds: 3
}

interface Thread {
  stored: string
  runtime: string
  messages: { role: string; text: string }[]
  running: boolean
  inflight?: Record<string, unknown>
  openRequests?: { id: string; method: string; params: Record<string, unknown> }[]
}

type Call = [profile: string, method: string, params: Record<string, unknown>]

/** One engine per assistant; each holds that assistant's thread. */
class Engines {
  calls: Call[] = []
  threads: Record<string, Thread | undefined> = {}
  up = new Set(['default', 'writer', 'editor', 'titles'])
  room = true
  listeners = new Set<(event: GatewayEvent) => void>()
  /** Throw this from the next matching request, once per entry. */
  failures: { error: unknown; method: string; profile: string; then?: () => void }[] = []
  created = 0

  thread(profile: string, patch: Partial<Thread> = {}): Thread {
    const thread: Thread = {
      messages: [],
      running: false,
      runtime: `${profile}-live`,
      stored: `${profile}-root`,
      ...patch
    }

    this.threads[profile] = thread

    return thread
  }

  callsTo(profile: string, method?: string): Call[] {
    return this.calls.filter(([p, m]) => p === profile && (!method || m === method))
  }

  emit(type: string, sessionId: string, payload: Record<string, unknown> = {}): void {
    for (const listener of this.listeners) {
      listener({ payload, session_id: sessionId, type } as GatewayEvent)
    }
  }

  /** The turn in `profile`'s thread ends with `reply`. */
  finish(profile: string, reply: string): void {
    const thread = this.threads[profile]!

    thread.messages.push({ role: 'assistant', text: reply })
    thread.running = false
    thread.inflight = undefined
    this.emit('message.complete', thread.runtime, { status: 'complete', text: reply })
  }

  /** The turn in `profile`'s thread fails (the engine retained the failed turn). */
  failTurn(profile: string, error: string, code: string): void {
    const thread = this.threads[profile]!

    thread.running = false
    thread.inflight = { ...(thread.inflight ?? {}), error, error_surface: { code }, status: 'error' }
    this.emit('message.complete', thread.runtime, { error, error_surface: { code }, status: 'error' })
  }

  request(profile: string) {
    return async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      this.calls.push([profile, method, params])
      // An RPC crosses IPC and a socket: the answer never lands in the same tick.
      await new Promise(resolve => setTimeout(resolve, 0))
      const failure = this.failures.findIndex(entry => entry.profile === profile && entry.method === method)

      if (failure >= 0) {
        const [{ error, then }] = this.failures.splice(failure, 1)

        then?.()

        throw error
      }

      return this.answer(profile, method, params) as T
    }
  }

  private answer(profile: string, method: string, params: Record<string, unknown>): unknown {
    const thread = this.threads[profile]

    if (method === 'session.list') {
      return { sessions: thread ? [{ id: thread.stored, title: MAIN_THREAD_TITLE }] : [] }
    }

    if (method === 'session.create') {
      this.created += 1

      return { session_id: this.thread(profile).runtime, stored_session_id: `${profile}-root` }
    }

    if (method === 'session.resume') {
      return {
        ...(thread?.inflight ? { inflight: thread.inflight } : {}),
        ...(thread?.openRequests?.length ? { open_requests: thread.openRequests } : {}),
        ...(params.omit_messages ? {} : { messages: thread?.messages ?? [] }),
        running: Boolean(thread?.running),
        session_id: thread?.runtime,
        session_key: thread?.stored
      }
    }

    if (method === 'prompt.submit') {
      thread!.messages.push({ role: 'user', text: String(params.text) })
      thread!.running = true
      thread!.inflight = { user: String(params.text) }

      return { status: 'streaming' }
    }

    if (method === 'session.interrupt') {
      thread!.running = false
    }

    return {}
  }
}

const ROSTER = botRosterFrom(
  [
    { is_default: true, name: 'default' },
    { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } },
    { name: 'editor', ui_meta: { apex: { created: 2, name: '剪辑' } } },
    { name: 'titles', ui_meta: { apex: { created: 3, name: '标题' } } }
  ],
  () => true
)

let engines: Engines
let runner: HandoffRunner
let threadChanged: ReturnType<typeof vi.fn<(profile: string) => void>>

function startRunner(): HandoffRunner {
  runner = createHandoffRunner(
    {
      engineUp: profile => engines.up.has(profile),
      onTurnEvent: listener => {
        engines.listeners.add(listener)

        return () => engines.listeners.delete(listener)
      },
      poolHasRoom: () => engines.room,
      request: profile => engines.request(profile),
      threadChanged
    },
    TIMING
  )
  setHandoffDispatcher(runner)

  return runner
}

function relay(patch: Partial<StartHandoffInput> = {}): HandoffRecord {
  const result = startHandoff({
    ask: '把这个选题写成小红书文案',
    from: { messageId: 'm-1', profile: 'default', storedSessionId: 'default-root' },
    previous: { files: ['/Users/me/选题.md'], text: '选题：秋天第一杯奶茶' },
    to: 'writer',
    ...patch
  })

  if (!result.ok) {
    throw new Error(result.reason)
  }

  return result.handoff
}

const status = (id: string) => handoffById(id)?.status
const record = (id: string) => handoffById(id)!

beforeEach(() => {
  localStorage.clear()
  resetHandoffsForTest()
  resetMainThreadForTest()
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  $authState.set({ ...$authState.get(), accountId: 'acct-1', status: 'signed-in' })
  resetBotRosterForTest(ROSTER)
  engines = new Engines()
  threadChanged = vi.fn<(profile: string) => void>()
})

afterEach(() => {
  $authState.set(SIGNED_OUT_AUTH)
  runner?.dispose()
  resetHandoffsForTest()
  resetMainThreadForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  localStorage.clear()
  vi.useRealTimers()
})

describe('one relay', () => {
  it('runs as a turn in the receiver’s own thread and brings back its 交回摘要', async () => {
    engines.thread('writer')
    const returned = vi.fn()

    onHandoffReturned(returned)
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))

    const [, , params] = engines.callsTo('writer', 'prompt.submit')[0]

    expect(params).toEqual({
      session_id: 'writer-live',
      text: composeHandoffRequest({
        ask: '把这个选题写成小红书文案',
        files: ['/Users/me/选题.md'],
        from: 'default',
        fromName: 'APEX',
        id: handoff.id,
        links: [],
        result: '选题：秋天第一杯奶茶'
      })
    })
    expect(record(handoff.id)).toMatchObject({
      attempts: 1,
      status: 'running',
      turn: { runtimeSessionId: 'writer-live', storedSessionId: 'writer-root' }
    })

    engines.finish(
      'writer',
      '写好了。\n\n<!-- apex:handback\n写好 3 段文案，第 2 段最稳。\n文件：/Users/me/文案.md\n-->'
    )

    await vi.waitFor(() => expect(status(handoff.id)).toBe('returned'))
    expect(record(handoff.id).result).toMatchObject({
      files: ['/Users/me/文案.md'],
      links: [],
      summary: '写好 3 段文案，第 2 段最稳。',
      text: '写好了。'
    })
    expect(returned).toHaveBeenCalledTimes(1)
    // Only the receiver's engine was asked anything, and no thread was made.
    expect(new Set(engines.calls.map(([profile]) => profile))).toEqual(new Set(['writer']))
    expect(engines.created).toBe(0)
  })

  it('creates the receiver’s 「APEX 主线」 when it has none, and lets the shell see it', async () => {
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))

    expect(engines.callsTo('writer', 'session.create')[0][2]).toEqual({
      cols: 96,
      profile: 'writer',
      source: 'desktop',
      title: MAIN_THREAD_TITLE
    })
    expect(threadChanged).toHaveBeenCalledWith('writer')

    engines.finish('writer', '好的，写完了')
    await vi.waitFor(() => expect(status(handoff.id)).toBe('returned'))
    expect(record(handoff.id).result?.summary).toBe('好的，写完了')
  })

  it('finds its reply by the hand-over id even when the user wrote in that thread before', async () => {
    engines.thread('writer', {
      messages: [
        { role: 'user', text: '早上好' },
        { role: 'assistant', text: '早上好！' }
      ]
    })
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(status(handoff.id)).toBe('running'))
    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.finish('writer', '这是交来的活的结果')

    await vi.waitFor(() => expect(record(handoff.id).result?.text).toBe('这是交来的活的结果'))
  })
})

describe('the queue (L3, L7)', () => {
  it('waits while the receiver’s thread is busy with its own turn, then goes', async () => {
    engines.thread('writer', { running: true })
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(record(handoff.id).queueReason).toBe('receiver_busy'))
    expect(record(handoff.id)).toMatchObject({ attempts: 0, status: 'queued' })
    expect(engines.callsTo('writer', 'prompt.submit')).toEqual([])

    // It looks again once per queue round, not in a tight loop.
    const before = engines.callsTo('writer', 'session.list').length

    await new Promise(resolve => setTimeout(resolve, TIMING.queueMs * 10))
    expect(engines.callsTo('writer', 'session.list').length - before).toBeLessThanOrEqual(12)

    engines.threads.writer!.running = false

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    expect(record(handoff.id).attempts).toBe(1)
  })

  it('runs at most two at once; the third waits for a slot', async () => {
    for (const profile of ['writer', 'editor', 'titles']) {
      engines.thread(profile)
    }

    startRunner()
    const a = relay()
    const b = relay({ to: 'editor' })
    const c = relay({ to: 'titles' })

    await vi.waitFor(() => expect(engines.calls.filter(([, method]) => method === 'prompt.submit')).toHaveLength(2))
    expect(record(c.id)).toMatchObject({ queueReason: 'running_cap', status: 'queued' })
    expect(engines.callsTo('titles')).toEqual([])

    engines.finish('writer', '好了')
    await vi.waitFor(() => expect(status(a.id)).toBe('returned'))
    await vi.waitFor(() => expect(engines.callsTo('titles', 'prompt.submit')).toHaveLength(1))
    expect(status(b.id)).toBe('running')
  })

  it('hands one receiver one relay at a time', async () => {
    engines.thread('writer')
    startRunner()
    const first = relay()
    const second = relay({ ask: '再写一版' })

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    expect(record(second.id)).toMatchObject({ queueReason: 'receiver_busy', status: 'queued' })

    engines.finish('writer', '第一版')
    await vi.waitFor(() => expect(status(first.id)).toBe('returned'))
    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(2))
    engines.finish('writer', '第二版')
    await vi.waitFor(() => expect(record(second.id).result?.text).toBe('第二版'))
  })

  it('never starts an engine into a full pool: nothing reaches the receiver until a slot frees', async () => {
    engines.thread('editor')
    engines.up.delete('editor')
    engines.room = false
    startRunner()
    const handoff = relay({ to: 'editor' })

    await vi.waitFor(() => expect(record(handoff.id).queueReason).toBe('pool_full'))
    await new Promise(resolve => setTimeout(resolve, TIMING.queueMs * 3))
    expect(engines.callsTo('editor')).toEqual([])

    engines.room = true
    await vi.waitFor(() => expect(engines.callsTo('editor', 'prompt.submit')).toHaveLength(1))
  })

  it('a full pool does not hold back a receiver whose engine is already up', async () => {
    engines.thread('writer')
    engines.room = false
    startRunner()
    relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
  })

  it('goes back to the queue when main’s slot wait times out (the pool was fuller than this window knew)', async () => {
    engines.thread('editor')
    engines.failures.push({
      error: new Error('Local backend start for "editor" timed out while waiting for a free slot. (background)'),
      method: 'session.list',
      profile: 'editor'
    })
    startRunner()
    const handoff = relay({ to: 'editor' })

    await vi.waitFor(() => expect(engines.callsTo('editor', 'prompt.submit')).toHaveLength(1))
    expect(record(handoff.id).attempts).toBe(1)
  })
})

describe('when the turn does not simply come back', () => {
  it('retries once when the platform was busy (relay 503), then stays failed', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.failTurn('writer', 'HTTP 503: 平台繁忙，请稍后再试。', 'overloaded')

    await vi.waitFor(() => expect(record(handoff.id).queueReason).toBe('platform_busy_retry'))
    expect(record(handoff.id).notBefore).toBeGreaterThan(Date.now() - 5)

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(2))
    engines.failTurn('writer', 'HTTP 503: 平台繁忙，请稍后再试。', 'overloaded')

    await vi.waitFor(() => expect(status(handoff.id)).toBe('failed'))
    expect(record(handoff.id).failure).toEqual({ kind: 'platform_busy', message: 'HTTP 503: 平台繁忙，请稍后再试。' })
    await new Promise(resolve => setTimeout(resolve, TIMING.retryAfterMs * 2))
    expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(2)
  })

  it('a failure left by an earlier turn in that thread is not this relay’s', async () => {
    engines.thread('writer')
    startRunner()
    // The user's own turn in 小红书文案's thread failed before the relay was handed over.
    engines.emit('message.complete', 'writer-live', {
      error: '平台繁忙',
      error_surface: { code: 'overloaded' },
      status: 'error'
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.finish('writer', '好了')

    await vi.waitFor(() => expect(status(handoff.id)).toBe('returned'))
  })

  it('a failure known only from its terminal frame (the retained turn is gone) still fails the relay', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.failTurn('writer', 'model refused', 'unknown')
    engines.threads.writer!.inflight = undefined

    await vi.waitFor(() => expect(status(handoff.id)).toBe('failed'))
    expect(record(handoff.id).failure).toEqual({ kind: 'turn_error', message: 'model refused' })
  })

  it('fails at once on any other turn failure', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.failTurn('writer', '本月可用额度已用完', 'billing')

    await vi.waitFor(() => expect(status(handoff.id)).toBe('failed'))
    expect(record(handoff.id).failure?.kind).toBe('turn_error')
    expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1)
  })

  it('shows 「在等你决定」 while the turn asks the user, then carries on', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.threads.writer!.openRequests = [{ id: 'q-1', method: 'clarify', params: { question: '用哪个开头？' } }]

    await vi.waitFor(() => expect(status(handoff.id)).toBe('waiting'))
    expect(record(handoff.id).waitingFor).toEqual({ kind: 'clarify', question: '用哪个开头？', requestId: 'q-1' })

    engines.threads.writer!.openRequests = []
    await vi.waitFor(() => expect(status(handoff.id)).toBe('running'))
    engines.finish('writer', '用第一个开头写好了')
    await vi.waitFor(() => expect(status(handoff.id)).toBe('returned'))
  })

  it('submits once more on a fresh session when the first was reaped before the submit (4001)', async () => {
    engines.thread('writer')
    engines.failures.push({
      error: { code: 4001, message: 'session not in memory' },
      method: 'prompt.submit',
      profile: 'writer',
      // The gateway reaped the live session: a resume mints a new one.
      then: () => {
        engines.threads.writer!.runtime = 'writer-live-2'
      }
    })
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(2))
    await vi.waitFor(() => expect(record(handoff.id).status).toBe('running'))
    // Within the same attempt: resume by the stored id, submit on the new session — no trip back to the queue.
    expect(
      engines
        .callsTo('writer')
        .map(([, method, params]) => `${method} ${String(params.session_id ?? '')}`)
        .slice(0, 5)
    ).toEqual([
      'session.list ',
      'session.resume writer-root',
      'prompt.submit writer-live',
      'session.resume writer-root',
      'prompt.submit writer-live-2'
    ])
    expect(record(handoff.id)).toMatchObject({ attempts: 1, turn: { runtimeSessionId: 'writer-live-2' } })
    engines.finish('writer', '好')
    await vi.waitFor(() => expect(status(handoff.id)).toBe('returned'))
  })

  it('keeps trying an engine that does not answer for a few rounds, then fails it', async () => {
    engines.thread('writer')

    for (let i = 0; i < TIMING.unreachableRounds; i += 1) {
      engines.failures.push({ error: new Error('connection refused'), method: 'session.list', profile: 'writer' })
    }

    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(status(handoff.id)).toBe('failed'))
    expect(record(handoff.id).failure?.kind).toBe('unreachable')
    expect(engines.callsTo('writer', 'prompt.submit')).toEqual([])
  })
})

describe('stopping and deleting', () => {
  it('「停下」 interrupts the relay’s own turn in the receiver’s thread', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    await stopHandoff(handoff.id)

    expect(engines.callsTo('writer', 'session.interrupt').map(([, , params]) => params)).toEqual([
      { session_id: 'writer-live' }
    ])
    expect(status(handoff.id)).toBe('stopped')

    engines.finish('writer', '已经停了')
    await new Promise(resolve => setTimeout(resolve, TIMING.pollMs * 3))
    expect(record(handoff.id).result).toBeNull()
  })

  it('never interrupts a turn the user started in that thread since', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    engines.threads.writer!.inflight = { user: '我自己问的另一件事' }
    await stopHandoff(handoff.id)

    expect(engines.callsTo('writer', 'session.interrupt')).toEqual([])
  })

  it('deleting the receiver mid-turn cancels the relay and stops following it (K9)', async () => {
    engines.thread('writer')
    startRunner()
    const handoff = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    await cancelHandoffsForProfile('writer')
    const seen = engines.calls.length

    await new Promise(resolve => setTimeout(resolve, TIMING.pollMs * 3))
    expect(record(handoff.id)).toMatchObject({ cancelReason: 'receiver_deleted', status: 'cancelled' })
    expect(engines.calls.length).toBe(seen)
  })
})

describe('a reopened window (Mac: closing the window keeps the app)', () => {
  /** A relay the last window left in its turn (no runner was running when it was queued). */
  function inTurn(reply: null | string, running: boolean): HandoffRecord {
    const handoff = relay()

    const text = composeHandoffRequest({
      ask: handoff.ask,
      files: [],
      from: 'default',
      fromName: 'APEX',
      id: handoff.id,
      links: [],
      result: null
    })

    engines.thread('writer', {
      messages: [{ role: 'user', text }, ...(reply === null ? [] : [{ role: 'assistant', text: reply }])],
      running
    })

    const turn = { requestText: text, runtimeSessionId: 'old-live', storedSessionId: 'writer-root', submittedAt: 1 }

    $handoffs.set($handoffs.get().map(r => (r.id === handoff.id ? { ...r, attempts: 1, status: 'running', turn } : r)))
    engines.calls = []

    return handoff
  }

  it('follows the turn it left and harvests it, never submitting again', async () => {
    const handoff = inTurn(null, true)

    startRunner().kick()
    await vi.waitFor(() => expect(engines.callsTo('writer', 'session.resume').length).toBeGreaterThan(0))
    engines.finish('writer', '关窗期间做完了')

    await vi.waitFor(() => expect(record(handoff.id).result?.text).toBe('关窗期间做完了'))
    expect(engines.callsTo('writer', 'prompt.submit')).toEqual([])
  })

  it('a reply that landed while the window was closed is harvested at once', async () => {
    const handoff = inTurn('早就做完了', false)

    startRunner().kick()
    await vi.waitFor(() => expect(status(handoff.id)).toBe('returned'))
  })

  it('a turn that ended with no reply (the app quit, Windows) reads as interrupted', async () => {
    const handoff = inTurn(null, false)

    startRunner().kick()
    await vi.waitFor(() => expect(status(handoff.id)).toBe('failed'))
    expect(record(handoff.id).failure?.kind).toBe('interrupted')
    expect(engines.callsTo('writer', 'prompt.submit')).toEqual([])
  })
})

describe('accounts', () => {
  const signIn = (accountId: string, status: 'checking' | 'signed-in' = 'signed-in') =>
    $authState.set({ ...$authState.get(), accountId, status })

  it('never runs another account’s relay: it is dropped before anything reaches an engine', async () => {
    engines.thread('writer')
    const theirs = relay()

    signIn('acct-2')
    startRunner().kick()

    await vi.waitFor(() => expect(handoffById(theirs.id)).toBeNull())
    expect(engines.calls).toEqual([])
  })

  it('the last account’s running relay: its turn is interrupted and never harvested', async () => {
    engines.thread('writer')
    startRunner()
    const theirs = relay()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'prompt.submit')).toHaveLength(1))
    signIn('acct-2')
    runner.kick()

    await vi.waitFor(() => expect(engines.callsTo('writer', 'session.interrupt')).toHaveLength(1))
    engines.finish('writer', '上一个账户的结果')
    await new Promise(resolve => setTimeout(resolve, TIMING.pollMs * 3))
    expect(handoffById(theirs.id)).toBeNull()
  })

  it('runs nothing while the account is not known', () => {
    engines.thread('writer')
    relay()
    signIn('acct-1', 'checking')
    vi.useFakeTimers()
    startRunner().kick()

    expect(engines.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('idle', () => {
  it('makes no request and keeps no timer', () => {
    vi.useFakeTimers()
    startRunner().kick()

    expect(engines.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
