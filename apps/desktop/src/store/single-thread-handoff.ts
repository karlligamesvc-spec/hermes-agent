/**
 * hc-1086 多助手二期 R1: relay (接力) between assistants in single-thread mode
 * — the records, the switch, and the interface the relay card (R2), the
 * 「交给 X」 button (R4) and the ledger line (R5) build on.
 *
 * A relay hands one piece of work from the assistant the user is talking to
 * (the sender) to another one (the receiver). It runs as one turn in the
 * receiver's own 「APEX 主线」, never in a hidden session, a group room or Bot
 * Chat (K5); the sender's side keeps a record of it: who to whom, what was
 * carried, its state, which turn, its place in the queue, and what came back.
 * app/single-thread/handoff-runner.ts dispatches the turns.
 *
 * Use cases:
 *
 * - R4 「交给 X」 / R2 @ picker: `startHandoff({ from, to, ask, previous })`.
 *   A refusal names why (`'nested'`: the sender is itself working on a relay;
 *   `'too_many_batons'`: the chain already has {@link HANDOFF_MAX_BATONS}).
 * - R2 relay card: `useStore($handoffs)` → `handoffsFrom(profile)`; status,
 *   `handoffQueuePosition(id)` for 「排第 N」, `waitingFor` for 「在等你决定」
 *   (jump to `to`'s thread, `turn.storedSessionId`), `stopHandoff(id)` for
 *   「停下」, `retryHandoff(id)` after a failure or 「被打断」.
 * - R2 「X 交来的活」: `handoffsTo(profile)`.
 * - R5 ledger line: `onHandoffReturned(record => …)`.
 * - R6 chain: `startHandoff({ …, continues: previous.id })`.
 * - K9: deleting an assistant calls `cancelHandoffsForProfile(profile)`
 *   (single-thread-bot-ops.ts `deleteBot`).
 *
 * Every relay belongs to the managed account it started under (`owner`). Signing
 * out or into another account ends and drops the previous account's relays
 * ({@link dropHandoffsOfOtherAccounts}), so nothing one account handed over
 * comes back into another's thread or memory ledger; 交回 is announced only for
 * the account signed in now.
 *
 * The switch is `desktop_features.multi_bot_handoff` or this install's
 * APEXNODES_MULTI_BOT_HANDOFF, counted only while several assistants are on
 * (`$multiBotMode`: single-thread product mode with `multi_bot`). Off, nothing
 * here runs and nothing is written.
 */

import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'

import type { DesktopClientConfigState } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'
import { HANDOFF_RESULT_MAX_CHARS, handoffCarryText } from '@/lib/handoff-text'
import { persistBoolean, readJson, storedBoolean, writeJson } from '@/lib/storage'

import { $authState, type DesktopAuthState } from './auth'
import { normalizeProfileKey } from './profile'
import { $botRoster, $multiBotFlag, $multiBotMode, botFor } from './single-thread-bots'

// ── the switch ───────────────────────────────────────────────────────────────

export const MULTI_BOT_HANDOFF_FEATURE = 'multi_bot_handoff'

/** The value this install last settled on, written only when it changes (off by default, so never off-path). */
export const MULTI_BOT_HANDOFF_HINT_KEY = 'apex.desktop.feature.multi-bot-handoff'

/** The switch as read: the admin client config or this install's own switch. */
export const $multiBotHandoffFlag = atom<boolean>(storedBoolean(MULTI_BOT_HANDOFF_HINT_KEY, false))

/** Relay on: the switch, while several assistants are on screen (single-thread product mode). */
export const $handoffMode = computed([$multiBotMode, $multiBotHandoffFlag], (several, on) => several && on)

/** For code outside React. The plain flags are read first, so the off path touches no computed store. */
export function isHandoffMode(): boolean {
  return $multiBotHandoffFlag.get() && $multiBotFlag.get() && $handoffMode.get()
}

export function useHandoffMode(): boolean {
  return useStore($handoffMode)
}

/** The switch for one cached client-config state: an install switch wins, else the platform's literal `true`. */
export function multiBotHandoffSwitchFrom(
  state: null | Pick<DesktopClientConfigState, 'installSwitches' | 'payload'> | undefined
): boolean {
  const install = state?.installSwitches?.[MULTI_BOT_HANDOFF_FEATURE]

  return typeof install === 'boolean' ? install : desktopFeatureOn(state?.payload, MULTI_BOT_HANDOFF_FEATURE)
}

function settleFlag(on: boolean): void {
  $multiBotHandoffFlag.set(on)

  if (storedBoolean(MULTI_BOT_HANDOFF_HINT_KEY, false) !== on) {
    persistBoolean(MULTI_BOT_HANDOFF_HINT_KEY, on)
  }
}

let readingFlag: null | Promise<boolean> = null

/** Read the switch once per window (a local disk read through main); never throws. Called only while several assistants are on. */
export function loadMultiBotHandoffFlag(): Promise<boolean> {
  readingFlag ??= (async () => {
    try {
      const state = await window.hermesDesktop?.clientConfig?.get()

      if (state) {
        settleFlag(multiBotHandoffSwitchFrom(state))
      }
    } catch {
      // Keep the hint: a broken bridge is not the platform turning the feature off.
    }

    return $multiBotHandoffFlag.get()
  })()

  return readingFlag
}

/** Tests only: forget the read and set the switch. */
export function setMultiBotHandoffFlagForTest(on: boolean): void {
  readingFlag = null
  settleFlag(on)
}

// ── limits (L3) ──────────────────────────────────────────────────────────────

/** Batons in one chain: the first relay and at most two carried on from its result. */
export const HANDOFF_MAX_BATONS = 3

/** Relays running at once (running or waiting on the user): with the assistant on screen, the primary engine + 2 pool engines. */
export const HANDOFF_MAX_RUNNING = 2

/** How much of the previous result is carried (L4, R3's `result_max_chars`); files and links ride beside it. */
export const HANDOFF_CARRY_MAX_CHARS = HANDOFF_RESULT_MAX_CHARS

// ── records ──────────────────────────────────────────────────────────────────

/**
 * - queued: waiting for a slot, the receiver, or an engine (`queueReason` says which);
 * - running: its turn is in the receiver's thread;
 * - waiting: that turn asks the user (a choice or an approval, `waitingFor`);
 * - returned: done, `result` holds what came back;
 * - failed: `failure` says why (a retry puts it back in the queue);
 * - stopped: the user stopped it (its turn was interrupted);
 * - cancelled: the receiver or the sender was deleted (`cancelReason`, K9).
 */
export type HandoffStatus = 'cancelled' | 'failed' | 'queued' | 'returned' | 'running' | 'stopped' | 'waiting'

/** Why a queued relay has not started yet. */
export type HandoffQueueReason =
  | 'pool_full' // the receiver's engine is not up and every pool slot is taken: no new engine, nobody evicted
  | 'receiver_busy' // the receiver's thread has a turn running (its own, or another relay)
  | 'running_cap' // HANDOFF_MAX_RUNNING relays are running
  | 'platform_busy_retry' // the platform was busy (relay 503); one automatic retry is waiting
  | 'unreachable' // the receiver's engine did not answer; tried again on the next round

export type HandoffFailureKind =
  | 'interrupted' // the turn ended without a reply (the app quit mid-turn on Windows, the engine died)
  | 'no_reply' // the turn finished but said nothing
  | 'platform_busy' // the platform stayed busy after the automatic retry
  | 'turn_error' // the turn failed for another reason
  | 'unreachable' // the receiver's engine never answered

export type HandoffCancelReason =
  | 'account_changed' // signed out, or into another account (the record then leaves this computer's list)
  | 'receiver_deleted'
  | 'sender_deleted'

/** Where the work came from: the sender's thread and the message whose result is carried (「来源」). */
export interface HandoffSource {
  profile: string
  /** The sender's name when the relay started (the hand-over says 【name 交来的活】); filled from the roster. */
  name?: string
  storedSessionId: null | string
  messageId: null | string
}

/**
 * The previous result as carried (L4): apex:next and apex:handback blocks taken out, cleaned, its
 * first {@link HANDOFF_CARRY_MAX_CHARS} code points (`truncated` past that), every file and link.
 */
export interface HandoffCarry {
  text: string
  truncated: boolean
  files: readonly string[]
  links: readonly string[]
}

/** The receiver's turn a relay runs as. */
export interface HandoffTurn {
  /** The receiver's thread as it was submitted to (its stored id). */
  storedSessionId: null | string
  /** The live session id the turn was submitted on (changes with a resume after the engine restarted). */
  runtimeSessionId: null | string
  submittedAt: number
  /** Exactly what was submitted: the reply is the assistant text after this user message. */
  requestText: string
}

/** What the receiver's turn asks the user, mirrored for 「在等你决定」; answered in the receiver's own thread. */
export interface HandoffPrompt {
  kind: 'approval' | 'clarify'
  requestId: string
  question: string
}

/** What came back (交回). */
export interface HandoffResult {
  /** The reply's full text. */
  text: string
  /** The return summary (R3's marker), else the reply's opening. */
  summary: string
  files: readonly string[]
  links: readonly string[]
  at: number
}

export interface HandoffRecord {
  id: string
  /** The first baton's id; equal to `id` for a relay that carries on nothing. */
  chainId: string
  /** 1-based place in the chain, at most {@link HANDOFF_MAX_BATONS}. */
  baton: number
  from: HandoffSource
  /** The receiving assistant's profile. */
  to: string
  /** What the user asked the receiver to do. */
  ask: string
  carry: HandoffCarry
  status: HandoffStatus
  createdAt: number
  updatedAt: number
  startedAt: null | number
  finishedAt: null | number
  turn: null | HandoffTurn
  /** Submits so far (the platform-busy retry is the second). */
  attempts: number
  /** Not before this time (the platform-busy retry waits a little). */
  notBefore: null | number
  queueReason: null | HandoffQueueReason
  waitingFor: null | HandoffPrompt
  result: null | HandoffResult
  failure: null | { kind: HandoffFailureKind; message: string }
  cancelReason: null | HandoffCancelReason
  /** The managed account it started under (the login's subject); null without a managed login. */
  owner: null | string
}

const ACTIVE: ReadonlySet<HandoffStatus> = new Set(['queued', 'running', 'waiting'])

/** Queued, running or waiting: not over yet. */
export function isHandoffActive(record: Pick<HandoffRecord, 'status'>): boolean {
  return ACTIVE.has(record.status)
}

/** Running or waiting on the user: holds one of the {@link HANDOFF_MAX_RUNNING} slots. */
export function isHandoffInTurn(record: Pick<HandoffRecord, 'status'>): boolean {
  return record.status === 'running' || record.status === 'waiting'
}

const STORE_KEY = 'apex.single-thread.handoffs.v1'

/** Settled records kept for the cards; the oldest go first. Active ones are always kept. */
const SETTLED_KEPT = 60

function isRecord(value: unknown): value is HandoffRecord {
  const row = value as Partial<HandoffRecord> | null

  return Boolean(
    row &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    typeof row.to === 'string' &&
    typeof row.status === 'string' &&
    row.from &&
    typeof row.from.profile === 'string'
  )
}

function loadRecords(): HandoffRecord[] {
  const raw = readJson<unknown>(STORE_KEY)

  return Array.isArray(raw) ? raw.filter(isRecord) : []
}

/** Every relay this install knows, oldest first. Read from this install's storage, so a reopened window picks them up. */
export const $handoffs = atom<readonly HandoffRecord[]>(loadRecords())

function trimmed(records: readonly HandoffRecord[]): HandoffRecord[] {
  const settled = records.filter(record => !isHandoffActive(record))
  const drop = new Set(settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT)).map(record => record.id))

  return records.filter(record => !drop.has(record.id))
}

function save(records: readonly HandoffRecord[]): void {
  const next = trimmed(records)

  $handoffs.set(next)
  writeJson(STORE_KEY, next)
}

export function handoffById(id: string, records: readonly HandoffRecord[] = $handoffs.get()): HandoffRecord | null {
  return records.find(record => record.id === id) ?? null
}

/** The relays an assistant sent, oldest first (its relay cards). */
export function handoffsFrom(profile: string, records: readonly HandoffRecord[] = $handoffs.get()): HandoffRecord[] {
  const key = normalizeProfileKey(profile)

  return records.filter(record => record.from.profile === key)
}

/** The relays an assistant was handed, oldest first (its 「X 交来的活」). */
export function handoffsTo(profile: string, records: readonly HandoffRecord[] = $handoffs.get()): HandoffRecord[] {
  const key = normalizeProfileKey(profile)

  return records.filter(record => record.to === key)
}

/** 1-based place among the queued relays (first come, first served); null when not queued. */
export function handoffQueuePosition(id: string, records: readonly HandoffRecord[] = $handoffs.get()): null | number {
  const queued = records.filter(record => record.status === 'queued')
  const index = queued.findIndex(record => record.id === id)

  return index < 0 ? null : index + 1
}

/**
 * Change one record (the dispatcher's and this module's only write path).
 * Returns the record as saved, or null when it is gone.
 */
export function updateHandoff(
  id: string,
  change: Partial<HandoffRecord> | ((record: HandoffRecord) => Partial<HandoffRecord>)
): HandoffRecord | null {
  const records = $handoffs.get()
  const current = handoffById(id, records)

  if (!current) {
    return null
  }

  const patch = typeof change === 'function' ? change(current) : change
  const next: HandoffRecord = { ...current, ...patch, updatedAt: Date.now() }

  save(records.map(record => (record.id === id ? next : record)))
  announce(current, next)

  return next
}

// ── what came back ───────────────────────────────────────────────────────────

type HandoffListener = (record: HandoffRecord) => void

const returnedListeners = new Set<HandoffListener>()
const settledListeners = new Set<HandoffListener>()

function subscribe(set: Set<HandoffListener>, listener: HandoffListener): () => void {
  set.add(listener)

  return () => {
    set.delete(listener)
  }
}

/** A relay came back with a result (交回). R5 writes its ledger line here. */
export function onHandoffReturned(listener: HandoffListener): () => void {
  return subscribe(returnedListeners, listener)
}

/** A relay is over: returned, failed, stopped or cancelled. */
export function onHandoffSettled(listener: HandoffListener): () => void {
  return subscribe(settledListeners, listener)
}

function fire(set: Set<HandoffListener>, record: HandoffRecord): void {
  for (const listener of [...set]) {
    try {
      listener(record)
    } catch (error) {
      console.error('[handoff] listener failed', error)
    }
  }
}

function announce(before: HandoffRecord, after: HandoffRecord): void {
  if (!isHandoffActive(before) || isHandoffActive(after)) {
    return
  }

  // 交回 reaches the ledger of the account signed in now, never another one's.
  if (after.status === 'returned' && isOwnHandoff(after)) {
    fire(returnedListeners, after)
  }

  fire(settledListeners, after)
}

// ── starting ─────────────────────────────────────────────────────────────────

/** The previous result as handed in by the caller (the message under 「交给 X」, or a chain's last baton). */
export interface HandoffPrevious {
  text: string
  files?: readonly string[]
  links?: readonly string[]
}

export interface StartHandoffInput {
  from: HandoffSource
  /** The receiving assistant's profile; it must be on the roster. */
  to: string
  /** What the user asks the receiver to do. */
  ask: string
  /** The result being handed on; omitted when the ask stands alone. */
  previous?: HandoffPrevious | null
  /** The baton this one carries on from (same chain, its result as `previous` unless given). */
  continues?: null | string
}

export type StartHandoffRefusal =
  | 'empty' // no ask (the hand-over always says 要你做)
  | 'nested' // the sender is itself working on a relay (接手的不能再往外交)
  | 'off' // the switch is off, or the account is not known yet
  | 'self' // handed to the sender itself
  | 'too_many_batons' // the chain already has HANDOFF_MAX_BATONS
  | 'unknown_continues' // `continues` names no relay that came back
  | 'unknown_receiver' // `to` is not on the roster

export type StartHandoffResult = { handoff: HandoffRecord; ok: true } | { ok: false; reason: StartHandoffRefusal }

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))]
}

/** L4 (R3 `request`): the previous result as it goes along, with every file and link. */
export function carryFrom(previous: HandoffPrevious | null | undefined): HandoffCarry {
  return { ...handoffCarryText(previous?.text), files: unique(previous?.files), links: unique(previous?.links) }
}

function newHandoffId(now: number): string {
  return `ho_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── whose relays ─────────────────────────────────────────────────────────────

/**
 * The account relays belong to now: the managed login's subject, null without
 * one (signed out, or a build without managed login); undefined until the first
 * auth check has said (a cached sign-in paints before its subject is known).
 */
export function handoffAccount(): null | string | undefined {
  return handoffAccountOf($authState.get())
}

export function handoffAccountOf(auth: Pick<DesktopAuthState, 'accountId' | 'status'>): null | string | undefined {
  return auth.status === 'checking' || auth.accountId === undefined ? undefined : auth.accountId
}

/** A relay of the account signed in now (never while that is still unknown). */
export function isOwnHandoff(record: Pick<HandoffRecord, 'owner'>, account = handoffAccount()): boolean {
  return account !== undefined && (record.owner ?? null) === account
}

/**
 * Signed out, or into another account: every relay of another account ends —
 * a turn still running for it is interrupted — and leaves this computer's list,
 * so its cards and its result never reach the account now signed in. Resolves
 * to how many were dropped. Nothing happens while the account is unknown.
 */
export async function dropHandoffsOfOtherAccounts(account = handoffAccount()): Promise<number> {
  if (account === undefined) {
    return 0
  }

  const foreign = $handoffs.get().filter(record => (record.owner ?? null) !== account)

  if (!foreign.length) {
    return 0
  }

  for (const record of foreign.filter(isHandoffActive)) {
    updateHandoff(record.id, {
      cancelReason: 'account_changed',
      finishedAt: Date.now(),
      queueReason: null,
      status: 'cancelled',
      waitingFor: null
    })
  }

  const gone = new Set(foreign.map(record => record.id))

  save($handoffs.get().filter(record => !gone.has(record.id)))
  await Promise.all(foreign.filter(isHandoffInTurn).map(interruptTurn))

  return foreign.length
}

function refusalFor(input: StartHandoffInput, records: readonly HandoffRecord[]): StartHandoffRefusal | null {
  const from = normalizeProfileKey(input.from.profile)
  const to = normalizeProfileKey(input.to)

  // Off, or the account is not known yet (it owns every relay).
  if (!isHandoffMode() || handoffAccount() === undefined) {
    return 'off'
  }

  if (from === to) {
    return 'self'
  }

  if (!$botRoster.get().some(bot => bot.profile === to)) {
    return 'unknown_receiver'
  }

  if (records.some(record => record.to === from && isHandoffActive(record))) {
    return 'nested'
  }

  if (!input.ask.trim()) {
    return 'empty'
  }

  return null
}

/** Queue a relay. The dispatcher (handoff-runner.ts) starts it when a slot, the receiver and an engine are free. */
export function startHandoff(input: StartHandoffInput): StartHandoffResult {
  const records = $handoffs.get()
  const refusal = refusalFor(input, records)

  if (refusal) {
    return { ok: false, reason: refusal }
  }

  const before = input.continues ? handoffById(input.continues, records) : null

  if (input.continues && before?.status !== 'returned') {
    return { ok: false, reason: 'unknown_continues' }
  }

  const baton = before ? before.baton + 1 : 1

  if (baton > HANDOFF_MAX_BATONS) {
    return { ok: false, reason: 'too_many_batons' }
  }

  const now = Date.now()
  const id = newHandoffId(now)

  const previous: HandoffPrevious | null =
    input.previous ??
    (before?.result ? { files: before.result.files, links: before.result.links, text: before.result.text } : null)

  const handoff: HandoffRecord = {
    ask: input.ask.trim(),
    attempts: 0,
    baton,
    cancelReason: null,
    carry: carryFrom(previous),
    chainId: before?.chainId ?? id,
    createdAt: now,
    failure: null,
    finishedAt: null,
    from: {
      messageId: input.from.messageId ?? null,
      name: input.from.name?.trim() || botFor($botRoster.get(), input.from.profile).name,
      profile: normalizeProfileKey(input.from.profile),
      storedSessionId: input.from.storedSessionId ?? null
    },
    id,
    notBefore: null,
    owner: handoffAccount() ?? null,
    queueReason: null,
    result: null,
    startedAt: null,
    status: 'queued',
    to: normalizeProfileKey(input.to),
    turn: null,
    updatedAt: now,
    waitingFor: null
  }

  save([...records, handoff])
  dispatcher?.kick()

  return { handoff, ok: true }
}

// ── stopping ─────────────────────────────────────────────────────────────────

/** The dispatcher's side of stopping and starting (handoff-runner.ts installs it while relay is on). */
export interface HandoffDispatcher {
  /** Look at the queue now. */
  kick(): void
  /** Interrupt the receiver's turn a relay is running as; resolves when the request went out. */
  interrupt(record: HandoffRecord): Promise<void>
}

let dispatcher: HandoffDispatcher | null = null

export function setHandoffDispatcher(next: HandoffDispatcher | null): void {
  dispatcher = next
}

async function interruptTurn(record: HandoffRecord): Promise<void> {
  if (!isHandoffInTurn(record) || !dispatcher) {
    return
  }

  try {
    await dispatcher.interrupt(record)
  } catch {
    // The record is settled either way; the turn ends on its own or with its engine.
  }
}

/**
 * 「停下」: a queued relay leaves the queue; a running one has the receiver's
 * turn interrupted. Resolves to whether there was anything to stop.
 */
export async function stopHandoff(id: string): Promise<boolean> {
  const record = handoffById(id)

  if (!record || !isHandoffActive(record)) {
    return false
  }

  updateHandoff(id, { finishedAt: Date.now(), queueReason: null, status: 'stopped', waitingFor: null })
  await interruptTurn(record)
  dispatcher?.kick()

  return true
}

/**
 * K9: an assistant is being deleted. Every relay still queued or running to it
 * or from it is cancelled; one running in a surviving receiver's thread has
 * that turn interrupted (nobody is left to hand it back to). Resolves to how
 * many were cancelled. No relay, no work: the switch-off path reads one atom.
 */
export async function cancelHandoffsForProfile(profile: string): Promise<number> {
  const key = normalizeProfileKey(profile)

  const hit = $handoffs
    .get()
    .filter(record => isHandoffActive(record) && (record.to === key || record.from.profile === key))

  for (const record of hit) {
    updateHandoff(record.id, {
      cancelReason: record.to === key ? 'receiver_deleted' : 'sender_deleted',
      finishedAt: Date.now(),
      queueReason: null,
      status: 'cancelled',
      waitingFor: null
    })
  }

  await Promise.all(hit.filter(record => record.to !== key).map(interruptTurn))

  if (hit.length) {
    dispatcher?.kick()
  }

  return hit.length
}

/** 「再试一次」 after a failure, a stop or 「被打断」: back to the end of the queue as the same relay. */
export function retryHandoff(id: string): boolean {
  const record = handoffById(id)

  if (
    !record ||
    (record.status !== 'failed' && record.status !== 'stopped') ||
    !isHandoffMode() ||
    !isOwnHandoff(record)
  ) {
    return false
  }

  updateHandoff(id, {
    attempts: 0,
    createdAt: Date.now(),
    failure: null,
    finishedAt: null,
    notBefore: null,
    queueReason: null,
    result: null,
    startedAt: null,
    status: 'queued',
    turn: null,
    waitingFor: null
  })

  // Back of the queue: the queue is ordered by the array, oldest first.
  const records = $handoffs.get()
  const moved = handoffById(id, records)

  if (moved) {
    save([...records.filter(other => other.id !== id), moved])
  }

  dispatcher?.kick()

  return true
}

/** Drop a settled relay (its card was closed). Active ones are stopped first by the caller. */
export function forgetHandoff(id: string): void {
  const records = $handoffs.get()
  const record = handoffById(id, records)

  if (record && !isHandoffActive(record)) {
    save(records.filter(other => other.id !== id))
  }
}

/** Tests only. */
export function resetHandoffsForTest(records: readonly HandoffRecord[] = []): void {
  returnedListeners.clear()
  settledListeners.clear()
  dispatcher = null
  $handoffs.set(records)
  writeJson(STORE_KEY, records.length ? records : null)
}
