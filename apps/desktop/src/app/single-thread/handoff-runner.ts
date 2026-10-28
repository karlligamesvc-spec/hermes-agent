/**
 * hc-1086 多助手二期 R1: the relay (接力) dispatcher. It runs every queued
 * relay (store/single-thread-handoff.ts) as one turn in the receiver's own
 * 「APEX 主线」 and brings back what it said.
 *
 * The pattern is upstream Bot Mode's member turn (plugins/hermes-bots/
 * group-turns.ts: submit, then poll the session until it settles, waking on
 * its terminal frame; mirror a question the member asks to the front; harvest
 * a reply that lands late), written here against the core session RPCs only —
 * no plugin import, no hidden session, no Bot Chat (K5):
 *
 * 1. Dispatch (L3, L7): first come, first served, at most
 *    {@link HANDOFF_MAX_RUNNING} in a turn at once, one per receiver. A
 *    receiver whose thread is busy waits (`receiver_busy`). A receiver whose
 *    engine is not up waits while every pool slot is taken (`pool_full`): the
 *    runner never starts an engine that would evict another one, and never
 *    touches the pool's own eviction (main's makeRoomInPool).
 * 2. Submit: find the receiver's thread by its title (create it when there is
 *    none), check it is idle, record the turn, then `prompt.submit` the
 *    hand-over (lib/handoff-text.ts, R3's format). The turn keeps its socket
 *    until it ends (session-request-router's turn lease).
 * 3. Follow: poll `session.resume` (messages omitted) until the turn settles,
 *    woken early by its `message.complete` / `error` frame. A choice or an
 *    approval it asks for marks the relay `waiting` (answered in the
 *    receiver's own thread). Settled, read the transcript once: the reply is
 *    the assistant text after the hand-over message (found by the id in its
 *    header), its 交回摘要 read per R3.
 * 4. Platform busy (relay 503, hc-1075): one automatic retry after
 *    `retryAfterMs`; a second failure stays failed.
 * 5. A reopened window (Mac: closing it keeps the app) adopts every relay
 *    still in a turn and harvests it; a turn that ended with no reply (the
 *    app quit on Windows) reads as `interrupted` (「再试一次」 retries it).
 *
 * Mounted by the multi-bot shell while relay is on and the gateway is open;
 * idle it makes no request and keeps no timer.
 */

import type { GatewayEvent } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { onGatewayEvent } from '@/contrib/events'
import { handbackResult, handoffRequestText, parseHandoffHeader } from '@/lib/handoff-text'
import { openSecondaryCount } from '@/store/gateway'
import { MAIN_THREAD_TITLE, resolveMainThread, resolveProfileThread } from '@/store/main-thread'
import { $poolLimits } from '@/store/pool-limits'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { requestForSessionProfile } from '@/store/session-request-router'
import { APEX_PROFILE } from '@/store/single-thread-bots'
import {
  $handoffMode,
  $handoffs,
  HANDOFF_MAX_RUNNING,
  handoffById,
  type HandoffDispatcher,
  type HandoffFailureKind,
  type HandoffPrompt,
  type HandoffQueueReason,
  type HandoffRecord,
  type HandoffTurn,
  isHandoffInTurn,
  loadMultiBotHandoffFlag,
  setHandoffDispatcher,
  updateHandoff
} from '@/store/single-thread-handoff'

export type HandoffRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface HandoffRunnerDeps {
  /** RPCs on `profile`'s own engine; a `prompt.submit` keeps that socket until its turn ends. */
  request(profile: string): HandoffRequest
  /** `profile`'s engine is up for this window: reaching it starts no engine. */
  engineUp(profile: string): boolean
  /** One more engine fits the pool without evicting another. */
  poolHasRoom(): boolean
  /** A turn's terminal frames (`message.complete`, `error`). */
  onTurnEvent(listener: (event: GatewayEvent) => void): () => void
  /** The receiver's thread was created or just took a turn: let the shell and its sidebar row see it. */
  threadChanged?(profile: string): void
}

export interface HandoffRunnerTiming {
  /** Backstop between polls of a running turn (its terminal frame wakes it sooner). */
  pollMs: number
  /** Quick rechecks right after a terminal frame, while the session flips `running` off. */
  settleMs: number
  /** How often a non-empty queue is looked at again (a busy receiver, a full pool). */
  queueMs: number
  /** The platform-busy retry waits this long. */
  retryAfterMs: number
  /** Failed reads in a row before a receiver counts as unreachable. */
  unreachableRounds: number
  /** Settled polls that do not show the hand-over yet before the turn counts as lost. */
  missingRounds: number
}

export const HANDOFF_RUNNER_TIMING: HandoffRunnerTiming = {
  missingRounds: 3,
  pollMs: 5_000,
  queueMs: 5_000,
  retryAfterMs: 20_000,
  settleMs: 250,
  unreachableRounds: 6
}

export interface HandoffRunner extends HandoffDispatcher {
  dispose(): void
}

/** Settles in a row after a terminal frame before falling back to the backstop. */
const SETTLE_RECHECKS = 8

/** Submits a relay may make: the first, and the platform-busy retry. */
const MAX_ATTEMPTS = 2

interface SessionSnapshot {
  inflight?: { error?: unknown; error_surface?: { code?: unknown }; status?: unknown; user?: unknown }
  messages?: TranscriptMessage[]
  open_requests?: { id?: string; method?: string; params?: Record<string, unknown> }[]
  pending_approval?: { command?: unknown; description?: unknown; request_id?: string }
  queued?: unknown
  running?: boolean
  session_id?: string
  session_key?: string
}

interface TranscriptMessage {
  content?: string | (string | { text?: string })[]
  role?: string
  text?: string
}

interface TurnFailure {
  /** When the frame arrived (frames only): one older than the relay's submit belongs to an earlier turn. */
  at?: number
  code: string
  message: string
}

function messageText(message: TranscriptMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  if (Array.isArray(message.content)) {
    return message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
  }

  return String(message.text ?? '')
}

/** The reply to the hand-over `id`: the last assistant text after it, before the next user message. Null: the hand-over is not there. */
function replyTo(messages: readonly TranscriptMessage[], id: string): null | string {
  const at = messages.findLastIndex(
    message => message.role === 'user' && parseHandoffHeader(messageText(message))?.id === id
  )

  if (at < 0) {
    return null
  }

  let reply = ''

  for (const message of messages.slice(at + 1)) {
    if (message.role === 'user') {
      break
    }

    const text = message.role === 'assistant' ? messageText(message).trim() : ''

    if (text) {
      reply = text
    }
  }

  return reply
}

/** The question the turn waits on the user for, mirrored from its snapshot (clarify first, as upstream). */
function pendingPrompt(state: SessionSnapshot | null): HandoffPrompt | null {
  const clarify = state?.open_requests?.find(entry => entry?.method === 'clarify' && entry.id)

  if (clarify?.id) {
    return { kind: 'clarify', question: String(clarify.params?.question ?? ''), requestId: clarify.id }
  }

  const approval = state?.pending_approval

  if (approval?.request_id) {
    const question =
      typeof approval.description === 'string' && approval.description ? approval.description : approval.command

    return { kind: 'approval', question: String(question ?? ''), requestId: approval.request_id }
  }

  return null
}

/** The relay 503 (hc-1075) after the engine's own retries: the engine classifies it `overloaded`. */
function isPlatformBusy(failure: TurnFailure): boolean {
  return failure.code === 'overloaded' || /平台繁忙|platform_busy|\b503\b/.test(failure.message)
}

/** A 4001-class "the runtime session was reaped" failure (upstream group-turns' rule; 4007 is "never existed"). */
function isSessionGone(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }

  if (code === 4007) {
    return false
  }

  return code === 4001 || /not in memory|session not found/i.test(String(message ?? ''))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error ?? '')
}

/** Main's slot wait timed out: the pool was full after all (its count can be ahead of this window's). */
function isSlotWait(error: unknown): boolean {
  return errorText(error).includes('timed out while waiting for a free slot')
}

export function createHandoffRunner(
  deps: HandoffRunnerDeps,
  timing: HandoffRunnerTiming = HANDOFF_RUNNER_TIMING
): HandoffRunner {
  let disposed = false
  let queueTimer: null | ReturnType<typeof setTimeout> = null
  /** Relays whose turn this runner is following now. */
  const following = new Set<string>()
  /** Failed dials in a row, per relay. */
  const unreachable = new Map<string, number>()
  /** Turn failures seen on terminal frames, by live session id. */
  const frameFailures = new Map<string, TurnFailure>()
  const waiters = new Set<{ ids: ReadonlySet<string>; wake: (signalled: boolean) => void }>()

  const offEvents = deps.onTurnEvent(event => {
    const sessionId = String(event.session_id ?? '')
    const payload = (event.payload ?? {}) as { error?: unknown; error_surface?: { code?: unknown }; status?: unknown }

    if (event.type === 'message.complete' && payload.status === 'error') {
      frameFailures.set(sessionId, {
        at: Date.now(),
        code: String(payload.error_surface?.code ?? ''),
        message: String(payload.error ?? '')
      })
    }

    for (const waiter of [...waiters]) {
      if (waiter.ids.has(sessionId)) {
        waiter.wake(true)
      }
    }
  })

  function sleep(ids: ReadonlySet<string>, ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const waiter = {
        ids,
        wake: (signalled: boolean) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(signalled)
        }
      }

      const timer = setTimeout(() => waiter.wake(false), ms)

      waiters.add(waiter)
    })
  }

  function inTurn(id: string): HandoffRecord | null {
    const record = handoffById(id)

    return !disposed && record && isHandoffInTurn(record) ? record : null
  }

  function settle(id: string, patch: Partial<HandoffRecord>): void {
    if (inTurn(id)) {
      updateHandoff(id, { finishedAt: Date.now(), queueReason: null, waitingFor: null, ...patch })
    }
  }

  function fail(id: string, kind: HandoffFailureKind, message = ''): void {
    settle(id, { failure: { kind, message }, status: 'failed' })
  }

  /** Back to the queue, looked at again on the next round (`queueMs`), never straight away. */
  function requeue(id: string, reason: HandoffQueueReason, patch: Partial<HandoffRecord> = {}): void {
    if (inTurn(id)) {
      updateHandoff(id, {
        notBefore: Date.now() + timing.queueMs,
        queueReason: reason,
        status: 'queued',
        turn: null,
        waitingFor: null,
        ...patch
      })
    }
  }

  /** A dial or submit that did not go through. The relay waits for the next round; enough of them in a row fail it. */
  function dialFailed(record: HandoffRecord, error: unknown): void {
    if (isSlotWait(error)) {
      requeue(record.id, 'pool_full', { attempts: Math.max(0, record.attempts - 1) })

      return
    }

    const rounds = (unreachable.get(record.id) ?? 0) + 1

    unreachable.set(record.id, rounds)

    if (rounds >= timing.unreachableRounds) {
      unreachable.delete(record.id)
      fail(record.id, 'unreachable', errorText(error))
    } else {
      requeue(record.id, 'unreachable', { attempts: Math.max(0, record.attempts - 1) })
    }
  }

  /** The receiver's thread, idle and resumed live; 'busy' when a turn is running in it. */
  async function openThread(
    request: HandoffRequest,
    profile: string
  ): Promise<'busy' | { created: boolean; runtime: string; stored: null | string }> {
    const thread = await resolveProfileThread(request, profile)

    if (thread.status === 'error') {
      throw new Error(`could not look up ${profile}'s thread`)
    }

    if (thread.status !== 'found' || !thread.tipId) {
      const created = await request<{ session_id?: string; stored_session_id?: string }>('session.create', {
        cols: 96,
        profile,
        source: 'desktop',
        title: MAIN_THREAD_TITLE
      })

      return { created: true, runtime: String(created?.session_id ?? ''), stored: created?.stored_session_id ?? null }
    }

    const state = await request<SessionSnapshot>('session.resume', {
      omit_messages: true,
      profile,
      session_id: thread.tipId
    })

    if (state?.running || state?.queued) {
      return 'busy'
    }

    return { created: false, runtime: String(state?.session_id ?? ''), stored: state?.session_key || thread.tipId }
  }

  /** prompt.submit, once more on a fresh live session when the first was reaped in between (#93602). */
  async function submitPrompt(
    request: HandoffRequest,
    profile: string,
    thread: { runtime: string; stored: null | string },
    text: string
  ): Promise<string> {
    try {
      await request('prompt.submit', { session_id: thread.runtime, text })

      return thread.runtime
    } catch (error) {
      if (!isSessionGone(error) || !thread.stored) {
        throw error
      }

      const state = await request<SessionSnapshot>('session.resume', {
        omit_messages: true,
        profile,
        session_id: thread.stored
      })

      const fresh = state?.session_id

      if (!fresh) {
        throw error
      }

      await request('prompt.submit', { session_id: fresh, text })

      return fresh
    }
  }

  async function submit(record: HandoffRecord): Promise<HandoffTurn | null> {
    const request = deps.request(record.to)

    try {
      const thread = await openThread(request, record.to)

      if (thread === 'busy') {
        requeue(record.id, 'receiver_busy', { attempts: Math.max(0, record.attempts - 1) })

        return null
      }

      const requestText = handoffRequestText({
        ask: record.ask,
        carry: record.carry,
        files: record.carry.files,
        from: record.from.profile,
        fromName: record.from.name || record.from.profile,
        id: record.id,
        links: record.carry.links
      })

      // Recorded before it goes out: a window that closes mid-submit adopts the turn, it never submits twice.
      const turn: HandoffTurn = {
        requestText,
        runtimeSessionId: thread.runtime || null,
        storedSessionId: thread.stored,
        submittedAt: Date.now()
      }

      if (!inTurn(record.id)) {
        return null
      }

      updateHandoff(record.id, { turn })
      const landed = await submitPrompt(request, record.to, thread, requestText)
      const moved = landed === thread.runtime ? turn : { ...turn, runtimeSessionId: landed }

      unreachable.delete(record.id)

      if (thread.created) {
        deps.threadChanged?.(record.to)
      }

      if (!inTurn(record.id)) {
        // Stopped (or its sender deleted) while the submit was on its way: stop the turn it started.
        await interrupt({ ...record, turn: moved }).catch(() => undefined)

        return null
      }

      if (moved !== turn) {
        updateHandoff(record.id, { turn: moved })
      }

      return moved
    } catch (error) {
      dialFailed(record, error)

      return null
    }
  }

  /** The turn ended: read its reply once. 'missing' while the hand-over is not in the transcript yet. */
  async function harvest(
    record: HandoffRecord,
    turn: HandoffTurn,
    ids: ReadonlySet<string>,
    sawRunning: boolean
  ): Promise<'done' | 'missing'> {
    const state = await deps.request(record.to)<SessionSnapshot>('session.resume', {
      profile: record.to,
      session_id: turn.storedSessionId || turn.runtimeSessionId
    })

    const reply = replyTo(state?.messages ?? [], record.id)
    const inflight = state?.inflight
    const ours = parseHandoffHeader(String(inflight?.user ?? ''))?.id === record.id

    // The thread is one session across turns: a failure counts only when it is this relay's turn —
    // the retained failed turn names its hand-over, a frame must be newer than the submit and only
    // stands in when there is no reply.
    const failure: null | TurnFailure =
      ours && inflight?.status === 'error'
        ? { code: String(inflight.error_surface?.code ?? ''), message: String(inflight.error ?? '') }
        : reply
          ? null
          : ([...ids].map(id => frameFailures.get(id)).find(frame => frame && (frame.at ?? 0) >= turn.submittedAt) ??
            null)

    if (reply === null && !failure) {
      return 'missing'
    }

    if (failure) {
      if (isPlatformBusy(failure) && record.attempts < MAX_ATTEMPTS) {
        requeue(record.id, 'platform_busy_retry', { notBefore: Date.now() + timing.retryAfterMs })
      } else {
        fail(record.id, isPlatformBusy(failure) ? 'platform_busy' : 'turn_error', failure.message)
      }

      return 'done'
    }

    if (!reply) {
      fail(record.id, sawRunning ? 'no_reply' : 'interrupted')

      return 'done'
    }

    settle(record.id, { result: { ...handbackResult(reply), at: Date.now() }, status: 'returned' })

    return 'done'
  }

  /** Follow a submitted turn until it settles, mirroring a question it asks the user. */
  async function follow(id: string, turn: HandoffTurn): Promise<void> {
    const ids = new Set([turn.runtimeSessionId].filter((value): value is string => Boolean(value)))
    let quick = 0
    let failedReads = 0
    let missing = 0
    let sawRunning = false
    let first = true

    while (inTurn(id)) {
      const signalled = first ? false : await sleep(ids, quick ? timing.settleMs : timing.pollMs)

      first = false
      quick = signalled ? SETTLE_RECHECKS : Math.max(0, quick - 1)

      const record = inTurn(id)

      if (!record) {
        return
      }

      let state: null | SessionSnapshot

      try {
        state = await deps.request(record.to)<SessionSnapshot>('session.resume', {
          omit_messages: true,
          profile: record.to,
          session_id: turn.storedSessionId || turn.runtimeSessionId
        })
        failedReads = 0
      } catch (error) {
        failedReads += 1

        if (failedReads >= timing.unreachableRounds) {
          fail(id, 'unreachable', errorText(error))
        }

        continue
      }

      if (state?.session_id) {
        ids.add(state.session_id)
      }

      const asked = pendingPrompt(state)

      if (asked) {
        if (record.waitingFor?.requestId !== asked.requestId || record.status !== 'waiting') {
          updateHandoff(id, { status: 'waiting', waitingFor: asked })
        }

        continue
      }

      if (record.status === 'waiting') {
        updateHandoff(id, { status: 'running', waitingFor: null })
      }

      if (state?.running) {
        sawRunning = true

        continue
      }

      try {
        if ((await harvest(record, turn, ids, sawRunning)) === 'done') {
          return
        }
      } catch (error) {
        failedReads += 1

        if (failedReads >= timing.unreachableRounds) {
          fail(id, 'unreachable', errorText(error))
        }

        continue
      }

      missing += 1

      if (missing >= timing.missingRounds) {
        fail(id, 'interrupted')
      }
    }
  }

  async function run(id: string, adopt: boolean): Promise<void> {
    following.add(id)

    try {
      const record = inTurn(id)

      if (!record) {
        return
      }

      const turn = adopt && record.turn ? record.turn : await submit(record)

      if (turn) {
        await follow(id, turn)
      }
    } finally {
      following.delete(id)

      if (!disposed) {
        tick()
      }
    }
  }

  function queueReason(
    record: HandoffRecord,
    free: number,
    busy: ReadonlySet<string>
  ): HandoffQueueReason | null | 'hold' {
    if (record.notBefore && Date.now() < record.notBefore) {
      return 'hold'
    }

    if (free <= 0) {
      return 'running_cap'
    }

    if (busy.has(record.to)) {
      return 'receiver_busy'
    }

    return deps.engineUp(record.to) || deps.poolHasRoom() ? null : 'pool_full'
  }

  function tick(): void {
    if (disposed) {
      return
    }

    if (queueTimer) {
      clearTimeout(queueTimer)
      queueTimer = null
    }

    // A reopened window (or a restarted app) follows what is still in a turn.
    for (const record of $handoffs.get()) {
      if (isHandoffInTurn(record) && !following.has(record.id)) {
        void run(record.id, true)
      }
    }

    const active = $handoffs.get().filter(isHandoffInTurn)
    const busy = new Set(active.map(record => record.to))
    let free = HANDOFF_MAX_RUNNING - active.length

    for (const record of $handoffs.get().filter(candidate => candidate.status === 'queued')) {
      const reason = queueReason(record, free, busy)

      if (reason === 'hold') {
        continue
      }

      if (reason) {
        if (record.queueReason !== reason) {
          updateHandoff(record.id, { queueReason: reason })
        }

        continue
      }

      free -= 1
      busy.add(record.to)
      updateHandoff(record.id, {
        attempts: record.attempts + 1,
        notBefore: null,
        queueReason: null,
        startedAt: record.startedAt ?? Date.now(),
        status: 'running',
        turn: null
      })
      void run(record.id, false)
    }

    if ($handoffs.get().some(record => record.status === 'queued')) {
      queueTimer = setTimeout(tick, timing.queueMs)
    }
  }

  async function interrupt(record: HandoffRecord): Promise<void> {
    const turn = record.turn

    if (!turn) {
      return
    }

    const request = deps.request(record.to)

    const state = await request<SessionSnapshot>('session.resume', {
      omit_messages: true,
      profile: record.to,
      session_id: turn.storedSessionId || turn.runtimeSessionId
    })

    // Only the relay's own turn: never one the user started in that thread since.
    if (
      state?.running &&
      state.session_id &&
      parseHandoffHeader(String(state.inflight?.user ?? ''))?.id === record.id
    ) {
      await request('session.interrupt', { session_id: state.session_id })
    }
  }

  function dispose(): void {
    disposed = true

    if (queueTimer) {
      clearTimeout(queueTimer)
      queueTimer = null
    }

    offEvents()

    for (const waiter of [...waiters]) {
      waiter.wake(false)
    }
  }

  return { dispose, interrupt, kick: tick }
}

/** Never used: every relay RPC names its profile, so the router never falls back to the ambient socket. */
function noAmbientRequest<T>(): Promise<T> {
  return Promise.reject(new Error('relay requests always name their profile'))
}

/** The runner against this window's gateway registry and pool. */
export function liveHandoffDeps(): HandoffRunnerDeps {
  const request =
    (profile: string): HandoffRequest =>
    (method, params = {}) =>
      requestForSessionProfile(profile, noAmbientRequest, method, params)

  return {
    // APEX's engine is the window's primary (the startup profile stays APEX, K7); another is up when it
    // is the active one or its pool socket is open here.
    engineUp: profile =>
      profile === APEX_PROFILE ||
      profile === normalizeProfileKey($activeGatewayProfile.get()) ||
      openSecondaryCount(profile) > 0,
    onTurnEvent: listener => {
      const offs = ['message.complete', 'error'].map(type => onGatewayEvent(type, listener))

      return () => offs.forEach(off => off())
    },
    // The prewarm's rule (store/profile.ts prewarmProfileBackend): one more socket must fit the cap.
    poolHasRoom: () => openSecondaryCount() < $poolLimits.get().maxBackends,
    request,
    // A thread the relay created: the assistant on screen moves into it, another one's row follows it.
    threadChanged: profile => {
      const lookup = request(profile)

      void (
        profile === normalizeProfileKey($activeGatewayProfile.get())
          ? resolveMainThread(lookup, profile)
          : resolveProfileThread(lookup, profile)
      ).catch(() => undefined)
    }
  }
}

/**
 * The shell's part (use-multi-bot-shell.ts): read the relay switch once several
 * assistants are on, and run the dispatcher while relay is on and the gateway
 * is open. Off, it reads nothing and runs nothing.
 */
export function useHandoffRunner(multiBot: boolean, gatewayOpen: boolean): void {
  const on = useStore($handoffMode) && multiBot && gatewayOpen

  useEffect(() => {
    if (multiBot) {
      void loadMultiBotHandoffFlag()
    }
  }, [multiBot])

  useEffect(() => {
    if (!on) {
      return
    }

    const runner = createHandoffRunner(liveHandoffDeps())

    setHandoffDispatcher(runner)
    runner.kick()

    return () => {
      setHandoffDispatcher(null)
      runner.dispose()
    }
  }, [on])
}
