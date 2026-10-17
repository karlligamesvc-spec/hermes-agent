/** A temporary process conflict is a deferred transaction, never an install failure. */
export class RuntimeUpdateBusy extends Error {
  readonly code = 'runtime_update_busy'
  constructor(message = 'Waiting for existing APEX work to finish.') {
    super(message)
    this.name = 'RuntimeUpdateBusy'
  }
}

export function isRuntimeUpdateBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'runtime_update_busy'
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
