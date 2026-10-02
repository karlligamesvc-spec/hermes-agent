import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain } from 'electron'
import { test } from 'vitest'

import { checkForRuntimeUpdate } from './apex-runtime-latest'
import { readSourceCommitStamp } from './bootstrap-runner'
import { registerDesktopVersionIpc } from './desktop-version'
import { createLocalBackendLifecycle } from './local-backend-lifecycle'
import { createPackagedRuntimeGate } from './packaged-runtime'
import { registerRuntimeVersionIpc, waitForPendingRuntimePreparation } from './runtime-version'

function deferred() {
  let resolve!: () => void

  const promise = new Promise<void>(done => {
    resolve = done
  })

  return { promise, resolve }
}

const previous = { pinnedCommit: 'a'.repeat(40), version: 'v2026.9.1-fork.aaaaaaaa' }
const target = { pinnedCommit: 'b'.repeat(40), version: 'v2026.10.1-fork.bbbbbbbb' }

function registerReaders(home: string, wait: () => Promise<void>, reads: string[]) {
  const markerPath = path.join(home, '.hermes-bootstrap-complete')

  const readMarker = () => {
    reads.push('marker')

    return fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null
  }

  const handlers = new Map<string, () => Promise<any>>()

  const ipcMain = {
    handle: (channel: string, listener: () => Promise<any>) => handlers.set(channel, listener)
  } as unknown as Pick<IpcMain, 'handle'>

  registerRuntimeVersionIpc(ipcMain, {
    waitForRuntimePreparation: wait,
    readMarker,
    readTreeCommit: () => {
      reads.push('tree')

      return readSourceCommitStamp(home)
    },
    minEngineVersion: () => null,
    log: () => {}
  })
  registerDesktopVersionIpc(ipcMain, {
    app: { getVersion: () => '0.17.40' },
    electronVersion: '40',
    engineVersion: () => {
      reads.push('engine')
      const versionPath = path.join(home, 'engine-version')

      return fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8') : 'unknown'
    },
    hermesRoot: () => home,
    nodeVersion: process.versions.node,
    platform: process.platform,
    waitForRuntimePreparation: wait
  })

  return {
    version: () => handlers.get('hermes:runtime:version')!(),
    desktopVersion: () => handlers.get('hermes:version')!(),
    check: () =>
      checkForRuntimeUpdate({
        apiBase: 'https://fixture.invalid',
        fetchJson: async () => ({ upstream_commit: target.pinnedCommit, version: target.version }),
        readCurrentMarker: async () => {
          await wait()

          return readMarker()
        }
      })
  }
}

function writeIdentity(home: string, identity: typeof previous) {
  fs.writeFileSync(path.join(home, '.hermes-bootstrap-complete'), JSON.stringify(identity))
  fs.writeFileSync(path.join(home, '.hermes-source-commit'), identity.pinnedCommit)
  fs.writeFileSync(path.join(home, 'engine-version'), identity.version)
}

test.each(['bundled', 'legacy-override', 'preserved', 'failed'] as const)(
  'version IPCs join a tracked %s start before reading marker and source',
  async outcome => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-version-read-'))
    const entered = deferred()
    const prepare = deferred()
    const activate = deferred()
    const reads: string[] = []

    const lifecycle = createLocalBackendLifecycle({
      stopChild: () => {
        throw new Error('Read-only version requests must not stop a worker')
      },
      waitForExit: async () => {
        throw new Error('Read-only requests must not await a live worker')
      },
      cancelSetup: () => {
        throw new Error('Read-only requests must not cancel setup')
      }
    })

    let installs = 0

    const gate = createPackagedRuntimeGate(async () => {
      installs += 1
      await activate.promise

      if (outcome === 'failed') {
        throw new Error('Actual preparation failed')
      }

      if (outcome === 'preserved') {
        return { status: 'preserved', runtimeCommit: previous.pinnedCommit }
      }

      writeIdentity(home, target)

      return { status: 'installed', runtimeCommit: target.pinnedCommit }
    })

    writeIdentity(home, previous)
    lifecycle.spawn(() => ({}))

    const startup = lifecycle.start(async () => {
      entered.resolve()
      await prepare.promise

      if (outcome === 'legacy-override') {
        // Opt-in runBootstrap also belongs to this start; it never enters the bundle gate.
        await activate.promise
        writeIdentity(home, target)
      } else {
        await gate()
      }
    })

    const settledStart = startup.catch(() => {})

    const wait = () =>
      waitForPendingRuntimePreparation({
        isPackaged: true,
        diagnostic: false,
        remote: false,
        managedRestorePending: false,
        waitForPendingStarts: lifecycle.waitForPendingStarts,
        waitForPackagedEngine: gate.waitForPending
      })

    const readers = registerReaders(home, wait, reads)
    let settledReads = 0

    const requests = Promise.all([readers.version(), readers.desktopVersion(), readers.check()]).then(result => {
      settledReads += 1

      return result
    })

    try {
      await entered.promise

      if (outcome === 'failed') {
        for (const file of ['.hermes-bootstrap-complete', '.hermes-source-commit', 'engine-version']) {
          fs.rmSync(path.join(home, file))
        }
      }

      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(reads, [], 'No identity is read while the tracked start has not entered its gate')
      assert.equal(settledReads, 0)
      assert.equal(installs, 0, 'A version request must never initiate installation')
      prepare.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(reads, [], 'No identity is read while activation is still in flight')
      activate.resolve()
      const [version, desktop, update] = await requests
      await settledStart
      const expected = outcome === 'failed' ? null : outcome === 'preserved' ? previous : target
      assert.equal(version.ok, true)
      assert.equal(version.commit, expected?.pinnedCommit ?? null)
      assert.equal(version.treeCommit, expected?.pinnedCommit ?? null)
      assert.equal(version.treeMatchesMarker, expected ? true : null)
      assert.equal(desktop.engineVersion, expected?.version ?? 'unknown')
      assert.equal(update.current.commit, expected?.pinnedCommit ?? null)
      assert.equal(update.updateAvailable, outcome === 'preserved')
      assert.equal(installs, outcome === 'legacy-override' ? 0 : 1)
      // A live child remains owned; a subsequent read still completes without stopping it.
      await readers.version()
      assert.equal(lifecycle.hasPending(), true)
    } finally {
      prepare.resolve()
      activate.resolve()
      await settledStart
      await requests.catch(() => {})
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

test('version reads do not start preparation or join unrelated remote/custom/diagnostic starts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-version-inert-'))
  const base = { isPackaged: true, diagnostic: false, remote: false, managedRestorePending: false }

  const forbiddenWait = async () => {
    throw new Error('An unrelated startup must not be joined')
  }

  try {
    writeIdentity(home, previous)

    for (const exclusion of [
      { isPackaged: false },
      { diagnostic: true },
      { explicitRoot: home },
      { remote: true },
      { managedRestorePending: true }
    ]) {
      const readers = registerReaders(
        home,
        () =>
          waitForPendingRuntimePreparation({
            ...base,
            ...exclusion,
            waitForPendingStarts: forbiddenWait,
            waitForPackagedEngine: forbiddenWait
          }),
        []
      )

      const [version, desktop] = await Promise.all([readers.version(), readers.desktopVersion()])
      assert.equal(version.commit, previous.pinnedCommit)
      assert.equal(desktop.engineVersion, previous.version)
    }

    const lifecycle = createLocalBackendLifecycle({
      stopChild: () => {},
      waitForExit: async () => {},
      cancelSetup: () => {}
    })

    const gate = createPackagedRuntimeGate(async () => {
      throw new Error('A version read must not install an engine')
    })

    const readers = registerReaders(
      home,
      () =>
        waitForPendingRuntimePreparation({
          ...base,
          waitForPendingStarts: lifecycle.waitForPendingStarts,
          waitForPackagedEngine: gate.waitForPending
        }),
      []
    )

    assert.equal((await readers.version()).commit, previous.pinnedCommit)
    assert.equal(lifecycle.hasPending(), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
