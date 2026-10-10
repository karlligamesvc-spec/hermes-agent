import { isRuntimeUpdateBusy } from './runtime-update-busy'

/** Retry only an occupancy conflict. Failed verification is never an auto-reload loop. */
export function createDeferredRuntimeUpdate(deps: {
  preflight: () => Promise<void>
  install: () => Promise<boolean>
  activated: () => void
  log: (message: string) => void
  retryMs?: number
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let disposed = false

  function schedule() {
    if (timer || disposed) {return}
    timer = setTimeout(() => {
      timer = undefined
      void attempt()
    }, deps.retryMs ?? 15_000)
    timer.unref?.()
  }

  async function attempt() {
    if (running || disposed) {return}
    running = true
    try {
      await deps.preflight()
      if (disposed) {return}
      if (await deps.install()) {
        if (!disposed) {deps.activated()}
      } else {
        schedule()
      }
    } catch (error) {
      if (isRuntimeUpdateBusy(error)) {schedule()}
      else {deps.log(`[bundled-engine] deferred upgrade stopped: ${String(error)}`)}
    } finally {
      running = false
    }
  }

  return { schedule, dispose: () => { disposed = true; clearTimeout(timer); timer = undefined } }
}
