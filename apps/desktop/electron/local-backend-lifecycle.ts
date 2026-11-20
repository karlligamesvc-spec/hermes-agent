import { createBackendShutdownCoordinator } from './backend-ownership'

/** Observe every branch, but never leave quit parked on a lost exit/SSH callback. */
export async function waitForTeardown(tasks: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface LocalBackendLifecycleDeps<Child> {
  stopChild: (child: Child) => void
  waitForExit: (child: Child) => Promise<void>
  cancelSetup: () => void
  /**
   * hc-1102: called for an owned child right before it is told to stop; what it returns runs once
   * the exit wait is over (apex-engine-children.ts `sweepEngineOnStop`). Children this lifecycle
   * never spawned — the messaging gateway goes through the same `stop` — are not swept.
   */
  sweepOnStop?: (child: Child) => () => Promise<unknown>
  timeoutMs?: number
}

/**
 * Physical ownership outlives routing entries: track starts before their first
 * await and children before their asynchronous identity claim. The permanent
 * shutdown signal and synchronous spawn fence make bounded waiting safe: a late
 * resolver can finish, but can never create another owned backend.
 *
 * hc-1255: every stop APEX asks for goes through `stop` (apex-engine-stop-wiring.test.ts), so a
 * child that exits without having been asked stopped on its own. And an engine start that arrives
 * while an update holds the fence waits for it (`startAfterUpdate`) instead of failing at the spawn.
 */
export function createLocalBackendLifecycle<Child extends object>(deps: LocalBackendLifecycleDeps<Child>) {
  const controller = new AbortController()
  const starts = new Set<Promise<unknown>>()
  const children = new Set<Child>()
  const stops = new Map<Child, Promise<void>>()
  // Never cleared: an exit handler may run after the child is released.
  const askedToStop = new WeakSet<Child>()
  const unfenceWaiters = new Set<() => void>()
  let updateFences = 0

  function stop(child: Child | null | undefined): Promise<void> {
    if (child == null) {
      return Promise.resolve()
    }

    askedToStop.add(child)
    const existing = stops.get(child)

    if (existing) {
      return existing
    }

    const stopping = (async () => {
      const sweep = children.has(child) ? deps.sweepOnStop?.(child) : undefined
      deps.stopChild(child)
      await deps.waitForExit(child)
      await sweep?.()
    })()

    stops.set(child, stopping)
    void stopping.then(
      () => stops.delete(child),
      () => stops.delete(child)
    )

    return stopping
  }

  function assertCanSpawn() {
    controller.signal.throwIfAborted()

    if (updateFences > 0) {throw new Error('The engine is being updated. Retry after the update completes.')}
  }

  const shutdown = createBackendShutdownCoordinator(() => {
    controller.abort(new Error('Hermes Desktop is quitting.'))
    deps.cancelSetup()

    return waitForTeardown([...starts, ...[...children].map(stop), ...stops.values()], deps.timeoutMs ?? 7_000)
  })

  function start<T>(run: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) {
      return Promise.reject(controller.signal.reason)
    }

    // Defer invocation one microtask so the inventory precedes all work.
    const promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()

      return run()
    })

    starts.add(promise)
    void promise.then(
      () => starts.delete(promise),
      () => starts.delete(promise)
    )

    return promise
  }

  /** Settles when the last update fence is released, or rejects when Desktop quits first. */
  function nextUnfence(): Promise<void> {
    return new Promise((resolve, reject) => {
      const quit = () => {
        unfenceWaiters.delete(resume)
        reject(controller.signal.reason)
      }

      const resume = () => {
        controller.signal.removeEventListener('abort', quit)
        resolve()
      }

      unfenceWaiters.add(resume)
      controller.signal.addEventListener('abort', quit, { once: true })
    })
  }

  function releaseFence() {
    updateFences -= 1

    if (updateFences === 0) {
      const waiting = [...unfenceWaiters]
      unfenceWaiters.clear()
      waiting.forEach(resume => resume())
    }
  }

  return {
    signal: controller.signal,
    assertCanSpawn,
    assertCanStart: () => controller.signal.throwIfAborted(),
    hasPending: () => starts.size > 0 || children.size > 0 || stops.size > 0 || shutdown.isPending(),
    ownedChildren: () => [...children],
    /** True once APEX asked this child to stop: its exit is then no crash. */
    stopRequested: (child: Child | null | undefined) => child != null && askedToStop.has(child),
    // A version read joins already-started preparation, never a live child or a new start.
    waitForPendingStarts: async () => {
      await Promise.allSettled([...starts])
    },
    start,
    /**
     * A tracked start that first waits out any engine update. A renderer reconnects as soon as an
     * update drains its engine; started at once, that start would run its probes beside the switch's
     * idle scan and then fail at the spawn fence. It starts once the update is released instead, or
     * never, when the update ends in a quit.
     */
    startAfterUpdate<T>(run: () => Promise<T>): Promise<T> {
      return start(async () => {
        while (updateFences > 0) {
          await nextUnfence()
        }

        return run()
      })
    },
    spawn(create: () => Child): Child {
      assertCanSpawn()
      const child = create()
      children.add(child)

      return child
    },
    release: (child: Child) => children.delete(child),
    // Do not join pending starts here: the installer itself belongs to a start.
    // Keep the fence through activation/rollback, then allow the new engine.
    fenceForUpdate: () => {
      updateFences += 1
      let released = false

      return {
        drain: () => Promise.all([...children].map(stop)),
        release: () => {
          if (!released) {released = true; releaseFence()}
        }
      }
    },
    stop,
    shutdown: shutdown.run
  }
}
