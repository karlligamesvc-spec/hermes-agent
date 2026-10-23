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

/** The apply answer for a busy engine: the frozen target waits for idle instead of failing. */
export function deferredRuntimeApply(pin: RuntimePin) {
  return { ok: true, applied: false, deferred: true, latest: { version: pin.version, key: pin.key } }
}

/** Preflight an apply before it changes anything: busy answers deferred, other failures still throw. */
export async function preflightApply(pin: RuntimePin, preflight: () => Promise<unknown>) {
  try {
    await preflight()

    return null
  } catch (error) {
    if (isRuntimeUpdateBusy(error)) {
      return deferredRuntimeApply(pin)
    }

    throw error
  }
}
