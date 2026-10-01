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
