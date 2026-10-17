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
  timeoutMs?: number
}

/**
 * Physical ownership outlives routing entries: track starts before their first
 * await and children before their asynchronous identity claim. The permanent
 * shutdown signal and synchronous spawn fence make bounded waiting safe: a late
 * resolver can finish, but can never create another owned backend.
 */
export function createLocalBackendLifecycle<Child>(deps: LocalBackendLifecycleDeps<Child>) {
  const controller = new AbortController()
  const starts = new Set<Promise<unknown>>()
  const children = new Set<Child>()
  const stops = new Map<Child, Promise<void>>()
  let updateFences = 0

  function stop(child: Child | null | undefined): Promise<void> {
    if (child == null) {
      return Promise.resolve()
    }

    const existing = stops.get(child)

    if (existing) {
      return existing
    }

    const stopping = (async () => {
      deps.stopChild(child)
      await deps.waitForExit(child)
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

  return {
    signal: controller.signal,
    assertCanSpawn,
    assertCanStart: () => controller.signal.throwIfAborted(),
    hasPending: () => starts.size > 0 || children.size > 0 || stops.size > 0 || shutdown.isPending(),
    ownedChildren: () => [...children],
    // A version read joins already-started preparation, never a live child or a new start.
    waitForPendingStarts: async () => {
      await Promise.allSettled([...starts])
    },
    start<T>(run: () => Promise<T>): Promise<T> {
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
          if (!released) {released = true; updateFences -= 1}
        }
      }
    },
    stop,
    shutdown: shutdown.run
  }
}
