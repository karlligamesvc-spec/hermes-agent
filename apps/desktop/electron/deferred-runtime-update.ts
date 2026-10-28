import { describeRuntimeUpdateBusy } from './engine-holders'
import type { PackagedRuntimeResult } from './packaged-runtime'
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
  let lastDeferral: null | string = null

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
      if (isRuntimeUpdateBusy(error)) {
        // hc-1094: say what the upgrade waits for, once per change, as the shell install does.
        const deferral = describeRuntimeUpdateBusy(error)

        if (deferral !== lastDeferral) {deps.log(`[bundled-engine] deferred upgrade still waiting: ${deferral}`)}
        lastDeferral = deferral
        schedule()
      }
      else {deps.log(`[bundled-engine] deferred upgrade stopped: ${String(error)}`)}
    } finally {
      running = false
    }
  }

  return { schedule, dispose: () => { disposed = true; clearTimeout(timer); timer = undefined } }
}

/**
 * At boot a busy packaged upgrade keeps the usable engine: report the deferral
 * and retry in the background until the target activates. Only occupancy is
 * retried; a preserved (failed) upgrade stops the retry.
 */
export function createPackagedEngineDeferral(deps: {
  preflight: () => Promise<void>
  /** Runs each retry's install as a tracked lifecycle start (hc-919 C3). */
  track: <T>(run: () => Promise<T>) => Promise<T>
  reinstall: () => Promise<PackagedRuntimeResult>
  clearPin: () => void
  activated: () => void
  log: (message: string) => void
  retryMs?: number
}) {
  let deferred = false

  const retry = createDeferredRuntimeUpdate({
    preflight: deps.preflight,
    install: () =>
      deps.track(async () => {
        const result = await deps.reinstall()

        if (result.reason === 'busy') {
          return false
        }

        if (result.status === 'preserved') {
          throw new Error('Bundled upgrade was not activated')
        }

        deps.clearPin()

        return true
      }),
    activated: deps.activated,
    log: deps.log,
    retryMs: deps.retryMs
  })

  return {
    isDeferred: () => deferred,
    /** The install finished (installed or current): nothing is waiting. */
    settle: () => {
      deferred = false
    },
    /** True, and the retry armed, when only occupancy blocked the install and the old engine still works. */
    deferIfBusy: (error: unknown, usable: () => boolean) => {
      deferred = isRuntimeUpdateBusy(error) && usable()

      if (deferred) {
        deps.log(`[bundled-engine] deferred while existing work finishes; keeping the current engine usable: ${describeRuntimeUpdateBusy(error)}`)
        retry.schedule()
      }

      return deferred
    },
    dispose: retry.dispose
  }
}
