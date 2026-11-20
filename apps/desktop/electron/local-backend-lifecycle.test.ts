import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { test, vi } from 'vitest'

import { createFirstRunSetupGate } from './first-run-setup-gate'
import { createLocalBackendLifecycle } from './local-backend-lifecycle'
import { createPackagedRuntimeGate } from './packaged-runtime'
import { runPrimaryBackendStartup } from './primary-backend-startup'
import { createQuitTeardownCoordinator } from './quit-teardown'

function deferred() {
  let resolve!: () => void

  const promise = new Promise<void>(done => {
    resolve = done
  })

  return { promise, resolve }
}

test('update fences late starts, drains all owned children and permits restart after rollback', async () => {
  const exit = deferred()
  const stopChild = vi.fn()
  const lifecycle = createLocalBackendLifecycle({ stopChild, waitForExit: () => exit.promise, cancelSetup: () => {} })
  lifecycle.spawn(() => ({ kind: 'backend' }))
  lifecycle.spawn(() => ({ kind: 'messaging' }))
  const fence = lifecycle.fenceForUpdate()
  const create = vi.fn(() => ({ kind: 'late' }))
  assert.throws(() => lifecycle.spawn(create), /being updated/)
  assert.equal(create.mock.calls.length, 0)
  let drained = false
  const drain = fence.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  assert.equal(stopChild.mock.calls.length, 2)
  exit.resolve()
  await drain
  fence.release()
  fence.release()
  assert.doesNotThrow(() => lifecycle.spawn(create))
  await lifecycle.shutdown()
  assert.throws(() => lifecycle.spawn(create), /quitting/)
})

test('the update preflight sees every owned child until it is released', () => {
  const lifecycle = createLocalBackendLifecycle({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {} })
  const backend = lifecycle.spawn(() => ({ kind: 'backend' }))
  const messaging = lifecycle.spawn(() => ({ kind: 'messaging' }))

  assert.deepEqual(lifecycle.ownedChildren(), [backend, messaging])
  lifecycle.release(backend)
  assert.deepEqual(lifecycle.ownedChildren(), [messaging])
})

test.each([false, true])('an already-tracked start is joined before its bundle gate exists (failed=%s)', async fails => {
  const prepare = deferred()
  const entered = deferred()

  const lifecycle = createLocalBackendLifecycle({
    stopChild: () => {throw new Error('A version read must not stop a child')},
    waitForExit: async () => {throw new Error('A version read must not wait for a live child')},
    cancelSetup: () => {}
  })

  let installs = 0

  const gate = createPackagedRuntimeGate(async () => {
    installs += 1

    return { status: 'installed', runtimeCommit: 'fixture' }
  })

  lifecycle.spawn(() => ({}))

  const startup = lifecycle.start(async () => {
    entered.resolve()
    await prepare.promise

    if (fails) {throw new Error('preparation failed')}

    await gate()
  })

  const settledStart = startup.catch(() => {})
  let joined = false

  const reading = lifecycle.waitForPendingStarts().then(async () => {
    await gate.waitForPending()
    joined = true
  })

  try {
    await entered.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(joined, false)
    assert.equal(installs, 0)
    prepare.resolve()
    await reading
    await settledStart
    assert.equal(joined, true)
    assert.equal(installs, fails ? 0 : 1)
    // The owned child remains live, but a second read has no startup to await.
    await lifecycle.waitForPendingStarts()
    assert.equal(lifecycle.hasPending(), true)
  } finally {
    prepare.resolve()
    await settledStart
  }
})

test('shutdown joins a removed start and prevents its late spawn', async () => {
  const resume = deferred()
  const spawn = vi.fn(() => ({}))

  const lifecycle = createLocalBackendLifecycle({
    stopChild: () => {},
    waitForExit: async () => {},
    cancelSetup: () => {}
  })

  const start = lifecycle.start(async () => {
    await resume.promise
    lifecycle.spawn(spawn)
  })

  void start.catch(() => {})
  await Promise.resolve()
  assert.equal(lifecycle.hasPending(), true)
  const shutdown = lifecycle.shutdown()
  resume.resolve()
  await shutdown
  await assert.rejects(start)
  assert.equal(spawn.mock.calls.length, 0)
  await assert.rejects(lifecycle.start(async () => {}))
})

test('shutdown retains a child before asynchronous claim and joins an earlier stop', async () => {
  const exit = deferred()
  const stopChild = vi.fn()
  const lifecycle = createLocalBackendLifecycle({ stopChild, waitForExit: () => exit.promise, cancelSetup: () => {} })
  const child = lifecycle.spawn(() => ({}))
  const stopping = lifecycle.stop(child)
  let done = false

  const shutdown = lifecycle.shutdown().then(() => {
    done = true
  })

  await Promise.resolve()
  assert.equal(done, false)
  assert.equal(stopChild.mock.calls.length, 1)
  exit.resolve()
  await Promise.all([shutdown, stopping])
})

test('shutdown is bounded even if startup ignores cancellation', async () => {
  vi.useFakeTimers()

  try {
    const lifecycle = createLocalBackendLifecycle({
      stopChild: () => {},
      waitForExit: async () => {},
      cancelSetup: () => {},
      timeoutMs: 20
    })

    void lifecycle.start(() => new Promise(() => {}))
    await Promise.resolve()
    const shutdown = lifecycle.shutdown()
    await vi.advanceTimersByTimeAsync(20)
    await shutdown
    assert.throws(() => lifecycle.spawn(() => ({})))
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.useRealTimers()
  }
})

test('the quit barrier cancels real first-run startup and waits for both local and SSH drains', async () => {
  const gate = createFirstRunSetupGate({ stuckAfterMs: 0 })
  const localExit = deferred()
  const sshExit = deferred()
  const finalQuit = vi.fn()
  const install = vi.fn(async () => ({}))

  const lifecycle = createLocalBackendLifecycle({
    stopChild: () => {},
    waitForExit: () => localExit.promise,
    cancelSetup: () => gate.resetForRetry()
  })

  lifecycle.spawn(() => ({}))

  const startup = lifecycle.start(() =>
    runPrimaryBackendStartup({
      signal: lifecycle.signal,
      resolveRemote: async () => null,
      connectRemote: async () => ({}),
      waitForLocalStart: async () => {},
      prepareLocalBackend: () => ({ kind: 'bootstrap-needed' }),
      waitForDecision: backend => gate.wait(backend),
      ensureLocalRuntime: install
    })
  )

  void startup.catch(() => {})

  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
  }

  assert.equal(gate.hasWaiter(), true)
  const quit = createQuitTeardownCoordinator(finalQuit)
  assert.equal(
    quit.begin([
      { run: () => lifecycle.shutdown(), waitForCompletion: lifecycle.hasPending() },
      { run: () => sshExit.promise, waitForCompletion: true }
    ]),
    true
  )
  await assert.rejects(startup)
  assert.equal(gate.hasWaiter(), false)
  assert.equal(install.mock.calls.length, 0)
  localExit.resolve()
  await lifecycle.shutdown()
  assert.equal(quit.begin([]), true)
  assert.equal(finalQuit.mock.calls.length, 0)
  sshExit.resolve()

  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }

  assert.equal(finalQuit.mock.calls.length, 1)
  assert.equal(quit.begin([]), false)
})

test('a child spawned before claim remains owned after the routing entry disappears', async () => {
  const lifecycle = createLocalBackendLifecycle<ReturnType<typeof spawn>>({
    stopChild: child => {
      child.kill()
    },
    waitForExit: async child => {
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit')
      }
    },
    cancelSetup: () => {}
  })

  const child = lifecycle.spawn(() =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  )

  child.once('exit', () => lifecycle.release(child))

  try {
    await once(child, 'spawn')
    // No connection-state attachment or persisted claim has happened yet.
    await lifecycle.shutdown()
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(lifecycle.hasPending(), false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
})

// hc-1102: every way an owned engine stops ends what it started outside its group, the way quitting
// does (apex-engine-children.ts sweepEngineOnStop): a direct stop (pool reap or eviction, a deleted
// assistant, a re-home, a failed start), the engine update's drain, and the quit itself.
interface Engine {
  kind: string
}

type Lifecycle = ReturnType<typeof createLocalBackendLifecycle<Engine>>

test.each<[string, (lifecycle: Lifecycle, engine: Engine) => Promise<unknown>]>([
  ['a direct stop', (lifecycle, engine) => lifecycle.stop(engine)],
  ['the update drain', lifecycle => lifecycle.fenceForUpdate().drain()],
  ['the quit', lifecycle => lifecycle.shutdown()]
])('%s sweeps an owned engine: snapshot before its signal, end after its exit', async (_name, run) => {
  const events: string[] = []
  const exit = deferred()

  const lifecycle = createLocalBackendLifecycle<Engine>({
    stopChild: engine => events.push(`stop ${engine.kind}`),
    waitForExit: async engine => {
      await exit.promise
      events.push(`exited ${engine.kind}`)
    },
    cancelSetup: () => {},
    sweepOnStop: engine => {
      events.push(`snapshot ${engine.kind}`)

      return async () => {
        events.push(`end ${engine.kind}`)
      }
    }
  })

  const engine = lifecycle.spawn(() => ({ kind: 'engine' }))
  const stopping = run(lifecycle, engine)

  await Promise.resolve()
  assert.deepEqual(events, ['snapshot engine', 'stop engine'])
  exit.resolve()
  await stopping
  assert.deepEqual(events, ['snapshot engine', 'stop engine', 'exited engine', 'end engine'])
})

test('a stop of a child the lifecycle never spawned (the messaging gateway) or already released sweeps nothing', async () => {
  const sweepOnStop = vi.fn(() => async () => {})
  const stopChild = vi.fn()
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild, waitForExit: async () => {}, cancelSetup: () => {}, sweepOnStop })
  const gateway = { kind: 'gateway' }
  const exited = lifecycle.spawn(() => ({ kind: 'exited engine' }))

  lifecycle.release(exited)
  await lifecycle.stop(gateway)
  await lifecycle.stop(exited)

  assert.deepEqual(stopChild.mock.calls, [[gateway], [exited]])
  assert.equal(sweepOnStop.mock.calls.length, 0)
})

test('a stop joined by the quit sweeps once', async () => {
  const exit = deferred()
  const ended = vi.fn()
  const sweepOnStop = vi.fn(() => async () => ended())
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: () => exit.promise, cancelSetup: () => {}, sweepOnStop })
  const engine = lifecycle.spawn(() => ({ kind: 'engine' }))
  const stopping = lifecycle.stop(engine)
  const quitting = lifecycle.shutdown()

  exit.resolve()
  await Promise.all([stopping, quitting])
  assert.equal(sweepOnStop.mock.calls.length, 1)
  assert.equal(ended.mock.calls.length, 1)
})

// hc-1255: an exit APEX asked for is no crash. main.ts's primary exit handler asks `stopRequested`
// before it tells the renderer the engine stopped (the sticky 「后端已停止」 toast), and every way
// APEX stops an engine goes through `stop` (apex-engine-stop-wiring.test.ts).
test.each<[string, (lifecycle: Lifecycle, engine: Engine) => Promise<unknown>]>([
  ['a direct stop (re-home, key restart, failed start)', (lifecycle, engine) => lifecycle.stop(engine)],
  ['the update drain', lifecycle => lifecycle.fenceForUpdate().drain()],
  ['the quit', lifecycle => lifecycle.shutdown()]
])('%s marks the engine as asked to stop, and the mark outlives its release', async (_name, run) => {
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {} })
  const engine = lifecycle.spawn(() => ({ kind: 'engine' }))

  assert.equal(lifecycle.stopRequested(engine), false)
  await run(lifecycle, engine)
  lifecycle.release(engine)
  assert.equal(lifecycle.stopRequested(engine), true)
  assert.equal(lifecycle.stopRequested(null), false)
  assert.equal(lifecycle.stopRequested(undefined), false)
})

test('an engine that exits by itself, or that only a stranger stops, was not asked to stop', async () => {
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {} })
  const crashed = lifecycle.spawn(() => ({ kind: 'crashed' }))
  const released = lifecycle.spawn(() => ({ kind: 'already exited' }))

  lifecycle.release(released)
  await lifecycle.fenceForUpdate().drain()
  assert.equal(lifecycle.stopRequested(crashed), true, 'the drain stops every owned engine')
  assert.equal(lifecycle.stopRequested(released), false, 'an engine gone before the drain was never asked')
  assert.equal(lifecycle.stopRequested({ kind: 'a stranger' }), false)
})

// The real order: spawnOwnedBackend's release listener runs before the primary's own exit handler.
test('a real engine the update drains reads as asked in its exit handler, one killed from outside does not', async () => {
  const lifecycle = createLocalBackendLifecycle<ReturnType<typeof spawn>>({
    stopChild: child => {
      child.kill()
    },
    waitForExit: async child => {
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit')
      }
    },
    cancelSetup: () => {}
  })

  const asked: Record<string, boolean> = {}

  const engine = (name: string) => {
    const child = lifecycle.spawn(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))

    child.once('exit', () => lifecycle.release(child))
    child.once('exit', () => {
      asked[name] = lifecycle.stopRequested(child)
    })

    return child
  }

  const crashed = engine('crashed')
  const drained = engine('drained')

  try {
    await Promise.all([once(crashed, 'spawn'), once(drained, 'spawn')])
    crashed.kill('SIGKILL')
    await once(crashed, 'exit')
    await lifecycle.fenceForUpdate().drain()
    assert.deepEqual(asked, { crashed: false, drained: true })
    assert.deepEqual(lifecycle.ownedChildren(), [])
  } finally {
    for (const child of [crashed, drained]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  }
})

// hc-1255: the update drain stops the engine, and the renderer reconnects at once. Started then, the
// reconnect's start would run its probes beside the switch's strict idle scan (and be named a holder
// there) and then fail at the spawn fence. It waits for the update to be released instead.
test('an engine start during an update waits for its release, then starts', async () => {
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {} })
  const fence = lifecycle.fenceForUpdate()
  const steps: string[] = []

  const reconnect = lifecycle.startAfterUpdate(async () => {
    steps.push('probes')

    return lifecycle.spawn(() => ({ kind: 'engine' }))
  })

  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }

  assert.deepEqual(steps, [])
  assert.equal(lifecycle.hasPending(), true)
  fence.release()
  assert.deepEqual(await reconnect, { kind: 'engine' })
  assert.deepEqual(steps, ['probes'])
})

test('an engine start waits for every update fence, and for one taken again before it resumes', async () => {
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {} })
  const shell = lifecycle.fenceForUpdate()
  const engine = lifecycle.fenceForUpdate()
  const run = vi.fn(async () => 'started')
  const started = lifecycle.startAfterUpdate(run)

  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
  }

  await settle()
  shell.release()
  await settle()
  assert.equal(run.mock.calls.length, 0, 'one fence is still held')
  engine.release()
  const again = lifecycle.fenceForUpdate()
  await settle()
  assert.equal(run.mock.calls.length, 0, 'a fence taken before the start resumed')
  again.release()
  assert.equal(await started, 'started')
  assert.equal(run.mock.calls.length, 1)
})

test('without a fence an engine start runs at once, and a plain start ignores the fence (the installer runs inside one)', async () => {
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {} })

  assert.equal(await lifecycle.startAfterUpdate(async () => 'now'), 'now')
  const fence = lifecycle.fenceForUpdate()

  try {
    assert.equal(await lifecycle.start(async () => 'installer'), 'installer')
  } finally {
    fence.release()
  }
})

test('an update that ends in a quit ends a waiting engine start without running it, and the quit does not wait for it', async () => {
  const lifecycle = createLocalBackendLifecycle<Engine>({ stopChild: () => {}, waitForExit: async () => {}, cancelSetup: () => {}, timeoutMs: 60_000 })

  lifecycle.fenceForUpdate()
  const run = vi.fn(async () => {})
  const reconnect = lifecycle.startAfterUpdate(run)

  void reconnect.catch(() => {})
  await Promise.resolve()
  await lifecycle.shutdown()
  await assert.rejects(reconnect, /quitting/)
  assert.equal(run.mock.calls.length, 0)
  assert.equal(lifecycle.hasPending(), false)
})
