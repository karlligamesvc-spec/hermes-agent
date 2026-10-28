import { describeRuntimeUpdateBusy, summarizeEngineHolders } from './engine-holders'

/** What an engine switch waits for. hc-1030: the shell install logs it and the update entry names it. */
export type RuntimeUpdateBusyReason = 'active_work' | 'activity_unknown' | 'engine_holders' | 'gateway_busy' | 'previous_worker'

const BUSY_REASONS: readonly unknown[] = ['active_work', 'activity_unknown', 'engine_holders', 'gateway_busy', 'previous_worker']

/** A temporary process conflict is a deferred transaction, never an install failure. */
export class RuntimeUpdateBusy extends Error {
  readonly code = 'runtime_update_busy'
  readonly reason: RuntimeUpdateBusyReason
  constructor(message = 'Waiting for existing APEX work to finish.', reason: RuntimeUpdateBusyReason = 'active_work') {
    super(message)
    this.name = 'RuntimeUpdateBusy'
    this.reason = reason
  }
}

export function isRuntimeUpdateBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'runtime_update_busy'
}

/** The reason a busy error carries; one without a known reason reads as running work. */
export function runtimeUpdateBusyReason(error: unknown): RuntimeUpdateBusyReason {
  const reason = (error as { reason?: unknown } | null)?.reason

  return BUSY_REASONS.includes(reason) ? (reason as RuntimeUpdateBusyReason) : 'active_work'
}

interface RuntimePin {
  key?: null | string
  version?: null | string
}

/**
 * The apply answer for a busy engine: the frozen target waits for idle instead of failing.
 * hc-1094: given the busy error, it also says what it waits for and names the engine holders
 * (the engine section shows them), and logs that once per answer.
 */
export function deferredRuntimeApply(pin: RuntimePin, busy?: unknown, log?: (message: string) => void) {
  const answer = { ok: true, applied: false, deferred: true, latest: { version: pin.version, key: pin.key } }

  if (busy === undefined) {
    return answer
  }

  log?.(`[runtime-update] apply deferred (version=${pin.version || '?'}): ${describeRuntimeUpdateBusy(busy)}`)

  return { ...answer, reason: runtimeUpdateBusyReason(busy), holders: summarizeEngineHolders(busy) }
}

/** Preflight an apply before it changes anything: busy answers deferred, other failures still throw. */
export async function preflightApply(pin: RuntimePin, preflight: () => Promise<unknown>, log?: (message: string) => void) {
  try {
    await preflight()

    return null
  } catch (error) {
    if (isRuntimeUpdateBusy(error)) {
      return deferredRuntimeApply(pin, error, log)
    }

    throw error
  }
}
