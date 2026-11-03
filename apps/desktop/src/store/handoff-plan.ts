/**
 * hc-1091 多助手二期 R6: the relay plan (一条龙接力) — up to three batons, run
 * one after another, each the next one's input. Every baton is a plain hc-1086
 * relay: `startHandoff` and its queue, its limits and its retries; there is no
 * second dispatcher.
 *
 * - The plan card (app/single-thread/handoff/plan-card.tsx) starts a plan on
 *   「开始」 ({@link startHandoffPlan}): it shows R5's usage line for every turn
 *   the plan runs and holds a used-up allowance back (L6). The first baton
 *   carries the reply the plan came in.
 * - The driver ({@link useHandoffPlanDriver}, mounted by the multi-bot shell
 *   beside the relay runner) starts each next baton once the one before came
 *   back, from that baton's result (`continues`). It reads the usage line
 *   first (`checkHandoffUsage(1)`); used up, the plan holds and says why.
 * - A baton that waits on the user (a choice, an approval) holds the plan
 *   there: the card says so and jumps to the receiver; answered, it goes on.
 *   A failed or interrupted baton holds it until the user retries it
 *   ({@link retryHandoffPlan}) or lets the rest go ({@link cancelRestOfPlan}).
 * - 「停下」 ({@link stopHandoffPlan}) stops the baton in its turn and ends the
 *   plan; 「剩下的不做了」 lets the current baton finish and runs nothing after.
 * - One plan runs at a time. A plan belongs to the account it started under
 *   and leaves this computer's list with it, as hc-1086's relays do.
 * - The planner itself on a relay (接手的不能再往外交): the first baton is
 *   refused (`nested`); a later one waits until that relay is over.
 *
 * Off (relay off), nothing here runs or writes: the driver is not mounted and
 * the records are only read at import.
 */

import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import { useEffect } from 'react'

import { HANDOFF_PLAN_MAX_LEGS } from '@/lib/handoff-plan'
import { readJson, writeJson } from '@/lib/storage'

import { $authState } from './auth'
import { checkHandoffUsage } from './handoff-usage'
import {
  $handoffMode,
  $handoffs,
  handoffAccount,
  handoffAccountOf,
  handoffById,
  type HandoffCancelReason,
  type HandoffPrevious,
  type HandoffRecord,
  type HandoffSource,
  isHandoffActive,
  isHandoffMode,
  retryHandoff,
  startHandoff,
  type StartHandoffRefusal,
  stopHandoff
} from './single-thread-handoff'

// ── records ──────────────────────────────────────────────────────────────────

/** A baton as the plan holds it: the planner's own part (「已有」), or a relay to an assistant on the roster. */
export type HandoffPlanStep =
  { kind: 'have'; label: string } | { kind: 'relay'; to: string; name: string; label: string; ask: string }

export type HandoffPlanRelayStep = Extract<HandoffPlanStep, { kind: 'relay' }>

/**
 * - running: a baton is on its way, or the plan waits on the user (a baton
 *   that asks, failed or was stopped; a next baton held back: `hold`);
 * - done: every baton came back;
 * - ended: it stopped before the last baton (`end` says why).
 */
export type HandoffPlanStatus = 'done' | 'ended' | 'running'

export type HandoffPlanEnd =
  | 'account_changed' // signed out, or into another account
  | 'baton_cancelled' // a baton's receiver or the planner was deleted (K9)
  | 'baton_gone' // a baton's record left the list
  | 'rest_cancelled' // 「剩下的不做了」
  | 'stopped' // 「停下」

/** Why the next baton has not started. */
export type HandoffPlanHold =
  | { kind: 'nested' } // the planner is itself working on a relay: started once that one is over
  | { kind: 'refused'; reason: StartHandoffRefusal } // hc-1086 said no (the receiver was deleted, relay off)
  | { kind: 'used_up'; reason: string } // the allowance is used up (R5's sentence)

export interface HandoffPlanRecord {
  id: string
  /** Which card it belongs to: {@link handoffPlanKey} of its thread and block. */
  key: string
  /** The managed account it started under (hc-1086 `handoffAccount`). */
  owner: null | string
  /** The planner's thread and the reply the plan came in. */
  from: HandoffSource
  steps: HandoffPlanStep[]
  /** The relays started so far, one per relay step, in order. */
  batons: string[]
  status: HandoffPlanStatus
  /** 「剩下的不做了」 while a baton is still on its way: the plan ends when it settles. */
  restCancelled: boolean
  hold: HandoffPlanHold | null
  end: HandoffPlanEnd | null
  /** The relay a K9 cancel named, for 「X 已删除」. */
  cancelReason: HandoffCancelReason | null
  createdAt: number
  updatedAt: number
  finishedAt: null | number
}

const STORE_KEY = 'apex.single-thread.handoff-plans.v1'

/** Finished plans kept for their cards; the oldest go first. A running one is always kept. */
const SETTLED_KEPT = 30

function isPlanRecord(value: unknown): value is HandoffPlanRecord {
  const row = value as Partial<HandoffPlanRecord> | null

  return Boolean(
    row &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    typeof row.key === 'string' &&
    typeof row.status === 'string' &&
    Array.isArray(row.steps) &&
    Array.isArray(row.batons) &&
    row.from &&
    typeof row.from.profile === 'string'
  )
}

function loadPlans(): HandoffPlanRecord[] {
  const raw = readJson<unknown>(STORE_KEY)

  return Array.isArray(raw) ? raw.filter(isPlanRecord) : []
}

/** Every plan this install knows, oldest first. */
export const $handoffPlans = atom<readonly HandoffPlanRecord[]>(loadPlans())

/** The relays that are batons of a plan: the plan card stands for them (hc-1087's slots leave them out). */
export const $handoffPlanBatonIds = computed($handoffPlans, (plans): ReadonlySet<string> => {
  const ids = new Set<string>()

  for (const plan of plans) {
    for (const id of plan.batons) {
      ids.add(id)
    }
  }

  return ids
})

function savePlans(plans: readonly HandoffPlanRecord[]): void {
  const settled = plans.filter(plan => plan.status !== 'running')
  const drop = new Set(settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT)).map(plan => plan.id))
  const next = plans.filter(plan => !drop.has(plan.id))

  $handoffPlans.set(next)
  writeJson(STORE_KEY, next)
}

export function handoffPlanById(
  id: string,
  plans: readonly HandoffPlanRecord[] = $handoffPlans.get()
): HandoffPlanRecord | null {
  return plans.find(plan => plan.id === id) ?? null
}

function updatePlan(id: string, patch: Partial<HandoffPlanRecord>): HandoffPlanRecord | null {
  const plans = $handoffPlans.get()
  const current = handoffPlanById(id, plans)

  if (!current) {
    return null
  }

  const next = { ...current, ...patch, updatedAt: Date.now() }

  savePlans(plans.map(plan => (plan.id === id ? next : plan)))

  return next
}

function endPlan(id: string, end: HandoffPlanEnd, patch: Partial<HandoffPlanRecord> = {}): void {
  updatePlan(id, { end, finishedAt: Date.now(), hold: null, status: 'ended', ...patch })
}

export function isOwnPlan(plan: Pick<HandoffPlanRecord, 'owner'>, account = handoffAccount()): boolean {
  return account !== undefined && (plan.owner ?? null) === account
}

export function planRelaySteps(plan: Pick<HandoffPlanRecord, 'steps'>): HandoffPlanRelayStep[] {
  return plan.steps.filter((step): step is HandoffPlanRelayStep => step.kind === 'relay')
}

/** The plan's latest baton, if it started one. */
export function currentPlanBaton(
  plan: Pick<HandoffPlanRecord, 'batons'>,
  records: readonly HandoffRecord[] = $handoffs.get()
): HandoffRecord | null {
  const id = plan.batons.at(-1)

  return id ? handoffById(id, records) : null
}

/** The account's plan that is running now, if any (one at a time). */
export function runningHandoffPlan(
  plans: readonly HandoffPlanRecord[] = $handoffPlans.get(),
  account = handoffAccount()
): HandoffPlanRecord | null {
  return plans.find(plan => plan.status === 'running' && isOwnPlan(plan, account)) ?? null
}

// ── which card ───────────────────────────────────────────────────────────────

/** FNV-1a, hex: a short, stable name for a block's text. */
function digest(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * A card's plan: its thread and what the block says. Message ids change when
 * a transcript is reloaded; the stored thread and the block's text do not.
 */
export function handoffPlanKey(storedSessionId: null | string, legs: unknown): string {
  return `${storedSessionId ?? ''}:${digest(JSON.stringify(legs))}`
}

/**
 * The plan a card stands for: the latest one with its key that started after
 * the reply was written (an identical block written later is a new proposal).
 */
export function planForCard(
  key: string,
  writtenAt: null | number,
  plans: readonly HandoffPlanRecord[] = $handoffPlans.get(),
  account = handoffAccount()
): HandoffPlanRecord | null {
  const found = plans.filter(
    plan => plan.key === key && isOwnPlan(plan, account) && (writtenAt === null || writtenAt <= plan.createdAt)
  )

  return found.at(-1) ?? null
}

// ── starting ─────────────────────────────────────────────────────────────────

export interface StartHandoffPlanInput {
  key: string
  /** The planner's thread and the reply the plan came in. */
  from: HandoffSource
  /** The batons, every relay resolved to an assistant on the roster. */
  steps: HandoffPlanStep[]
  /** The reply the plan came in, without its blocks: what the first baton carries. */
  previous: HandoffPrevious
}

export type StartHandoffPlanRefusal =
  | 'invalid' // no relay, or more batons than a plan may have
  | 'plan_running' // another plan of this account is running (one at a time)
  | StartHandoffRefusal

export type StartHandoffPlanResult =
  { ok: false; reason: StartHandoffPlanRefusal } | { ok: true; plan: HandoffPlanRecord }

function newPlanId(now: number): string {
  return `pl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 「开始」: the first baton is queued as a relay now; the driver starts the rest. */
export function startHandoffPlan(input: StartHandoffPlanInput): StartHandoffPlanResult {
  if (!isHandoffMode() || handoffAccount() === undefined) {
    return { ok: false, reason: 'off' }
  }

  const relays = planRelaySteps(input)

  if (!relays.length || input.steps.length > HANDOFF_PLAN_MAX_LEGS) {
    return { ok: false, reason: 'invalid' }
  }

  if (runningHandoffPlan()) {
    return { ok: false, reason: 'plan_running' }
  }

  const first = startHandoff({ ask: relays[0]!.ask, from: input.from, previous: input.previous, to: relays[0]!.to })

  if (!first.ok) {
    return first
  }

  const now = Date.now()

  const plan: HandoffPlanRecord = {
    batons: [first.handoff.id],
    cancelReason: null,
    createdAt: now,
    end: null,
    finishedAt: null,
    from: first.handoff.from,
    hold: null,
    id: newPlanId(now),
    key: input.key,
    owner: first.handoff.owner,
    restCancelled: false,
    status: 'running',
    steps: input.steps,
    updatedAt: now
  }

  savePlans([...$handoffPlans.get(), plan])

  return { ok: true, plan }
}

// ── the user's controls ──────────────────────────────────────────────────────

/** 「停下」: the baton on its way is stopped and nothing after it runs. */
export async function stopHandoffPlan(id: string): Promise<boolean> {
  const plan = handoffPlanById(id)

  if (!plan || plan.status !== 'running') {
    return false
  }

  const baton = currentPlanBaton(plan)

  endPlan(id, 'stopped')

  if (baton && isHandoffActive(baton)) {
    await stopHandoff(baton.id)
  }

  return true
}

/** 「剩下的不做了」: the baton on its way finishes; nothing after it runs. */
export function cancelRestOfPlan(id: string): boolean {
  const plan = handoffPlanById(id)

  if (!plan || plan.status !== 'running') {
    return false
  }

  const baton = currentPlanBaton(plan)

  if (baton && isHandoffActive(baton)) {
    updatePlan(id, { restCancelled: true })
  } else {
    endPlan(id, 'rest_cancelled')
  }

  return true
}

/**
 * 「再试一次」 on a plan held at a baton: the usage line is read first (a used-up
 * allowance keeps it where it is: the reason comes back); then a failed or
 * stopped baton runs again as the same relay, or a held-back next baton is
 * tried again. Null when it went ahead.
 */
export async function retryHandoffPlan(id: string): Promise<null | string> {
  const hint = await checkHandoffUsage(1)

  if (hint && !hint.start) {
    return hint.reason ?? ''
  }

  const plan = handoffPlanById(id)

  if (!plan || plan.status !== 'running') {
    return null
  }

  if (plan.hold) {
    updatePlan(id, { hold: null })
    reconcileHandoffPlans()

    return null
  }

  const baton = currentPlanBaton(plan)

  if (baton && (baton.status === 'failed' || baton.status === 'stopped')) {
    retryHandoff(baton.id)
  }

  return null
}

// ── the driver ───────────────────────────────────────────────────────────────

/** Plans whose next baton is being started (the usage read is on its way). */
const starting = new Set<string>()

/** The planner is itself working on a relay now: it cannot hand on until that is over (L3). */
function plannerOnRelay(plan: HandoffPlanRecord): boolean {
  return $handoffs.get().some(record => record.to === plan.from.profile && isHandoffActive(record))
}

async function startNextBaton(planId: string, after: string, step: HandoffPlanRelayStep): Promise<void> {
  starting.add(planId)

  try {
    const hint = await checkHandoffUsage(1)
    const plan = handoffPlanById(planId)

    // Stopped, let go or moved on while the usage line was read.
    if (!plan || plan.status !== 'running' || plan.batons.at(-1) !== after) {
      return
    }

    if (plan.restCancelled) {
      endPlan(planId, 'rest_cancelled')

      return
    }

    if (hint && !hint.start) {
      updatePlan(planId, { hold: { kind: 'used_up', reason: hint.reason ?? '' } })

      return
    }

    const result = startHandoff({ ask: step.ask, continues: after, from: plan.from, to: step.to })

    if (result.ok) {
      updatePlan(planId, { batons: [...plan.batons, result.handoff.id], hold: null })
    } else {
      updatePlan(planId, {
        hold: result.reason === 'nested' ? { kind: 'nested' } : { kind: 'refused', reason: result.reason }
      })
    }
  } finally {
    starting.delete(planId)
  }
}

function advance(plan: HandoffPlanRecord): void {
  const baton = currentPlanBaton(plan)

  if (!baton) {
    endPlan(plan.id, 'baton_gone')

    return
  }

  if (isHandoffActive(baton)) {
    return
  }

  if (baton.status === 'cancelled') {
    endPlan(plan.id, baton.cancelReason === 'account_changed' ? 'account_changed' : 'baton_cancelled', {
      cancelReason: baton.cancelReason
    })

    return
  }

  // Failed or stopped: held at this baton until the user retries it or lets the rest go.
  if (baton.status !== 'returned') {
    if (plan.restCancelled) {
      endPlan(plan.id, 'rest_cancelled')
    }

    return
  }

  const next = planRelaySteps(plan)[plan.batons.length]

  if (!next) {
    updatePlan(plan.id, { finishedAt: Date.now(), hold: null, status: 'done' })

    return
  }

  if (plan.restCancelled) {
    endPlan(plan.id, 'rest_cancelled')

    return
  }

  // Held back for the user (used up, refused), or already being started.
  if ((plan.hold && plan.hold.kind !== 'nested') || starting.has(plan.id)) {
    return
  }

  if (plannerOnRelay(plan)) {
    if (plan.hold?.kind !== 'nested') {
      updatePlan(plan.id, { hold: { kind: 'nested' } })
    }

    return
  }

  void startNextBaton(plan.id, baton.id, next)
}

/**
 * Look at every running plan of the account signed in now and move it on;
 * another account's plans leave the list. Nothing happens while relay is off
 * or the account is unknown.
 */
export function reconcileHandoffPlans(account = handoffAccount()): void {
  if (!isHandoffMode() || account === undefined) {
    return
  }

  const plans = $handoffPlans.get()

  if (plans.some(plan => !isOwnPlan(plan, account))) {
    savePlans(plans.filter(plan => isOwnPlan(plan, account)))
  }

  for (const plan of $handoffPlans.get().filter(candidate => candidate.status === 'running')) {
    advance(plan)
  }
}

/**
 * The shell's part (use-multi-bot-shell.ts), beside the relay runner: while
 * relay is on and the account is known, every change to the relays moves the
 * running plan on. Off, it reads and writes nothing.
 */
export function useHandoffPlanDriver(): void {
  const on = useStore($handoffMode)
  const account = handoffAccountOf(useStore($authState))

  useEffect(() => {
    if (!on || account === undefined) {
      return
    }

    reconcileHandoffPlans(account)

    return $handoffs.listen(() => reconcileHandoffPlans(account))
  }, [account, on])
}

/** Tests only. */
export function resetHandoffPlansForTest(plans: readonly HandoffPlanRecord[] = []): void {
  starting.clear()
  $handoffPlans.set(plans)
  writeJson(STORE_KEY, plans.length ? plans : null)
}
