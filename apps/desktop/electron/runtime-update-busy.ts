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
