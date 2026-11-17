// hc-1255: the race behind 「现在还不能安装 — APEX 自己的后台进程在用 APEX 引擎」, with real processes
// and the real psutil idle scan. On Kael's Mac (2026-11-08 and 11-17, 2 of 6 updates) the install's
// drain stopped the engine, the renderer re-dialled at once, and that engine start began with its
// import probe (`venv/bin/python -c <RUNTIME_YAML_IMPORT>…`, backend-probes.ts). The strict scan,
// 364 ms after the engine exited, named the probe `apex_running` and the install waited 15 s.
//
// An engine start now waits for the update to be released (`startAfterUpdate`; main.ts starts
// both engine spawners that way, pinned by apex-engine-stop-wiring.test.ts). The plain start is
// kept here as the control: it shows the scan really catches such a probe.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { createLocalBackendLifecycle } from './local-backend-lifecycle'
import { assertPackagedRuntimeIdle } from './packaged-runtime'

const bin = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'

// CI exports HERMES_PYTHON (the synced venv, psutil included); a dev checkout falls back to its .venv.
function fixtureVenv(): string {
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const python = process.env.HERMES_PYTHON || path.join(path.dirname(commonGit), '.venv', bin)

  return path.dirname(path.dirname(python))
}

type Restart = 'start' | 'startAfterUpdate'

interface Outcome {
  /** The kind of each holder the strict scan named right after the drain, or [] when idle. */
  holders: string[]
  probesDuringUpdate: number
  probesAfterRelease: number
}

/** The engine is drained for an update; its exit makes the renderer re-dial; then the strict scan. */
async function drainThenScan(restart: Restart): Promise<Outcome> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-reconnect-race-'))
  const root = path.join(home, 'hermes-agent')
  const probes: ReturnType<typeof spawn>[] = []

  fs.mkdirSync(root)
  fs.symlinkSync(fixtureVenv(), path.join(root, 'venv'), process.platform === 'win32' ? 'junction' : 'dir')

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

  const engine = lifecycle.spawn(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  let reconnect: Promise<unknown> = Promise.resolve()

  engine.once('exit', () => lifecycle.release(engine))
  // main.ts: the engine is gone, the renderer asks for a connection, and the start probes the engine first.
  engine.once('exit', () => {
    reconnect = lifecycle[restart](async () => {
      const probe = spawn(path.join(root, 'venv', bin), ['-c', 'import time; time.sleep(60)'], { cwd: home, stdio: 'ignore' })

      probes.push(probe)
      await once(probe, 'spawn')
    })
  })

  try {
    await once(engine, 'spawn')
    const fence = lifecycle.fenceForUpdate()

    await fence.drain()
    // The gate retires gateways and checks ownership before its strict scan; the start runs meanwhile.
    await new Promise(resolve => setTimeout(resolve, 300))

    const holders = await assertPackagedRuntimeIdle(root, root).then(
      () => [],
      (error: { idleProof?: { holders?: Record<string, { kind?: string } | undefined> } }) => {
        const named = error.idleProof?.holders

        if (!named) {
          throw error
        }

        return Object.values(named).map(holder => holder?.kind ?? 'unclassified')
      }
    )

    const probesDuringUpdate = probes.length

    fence.release()
    await reconnect

    return { holders, probesDuringUpdate, probesAfterRelease: probes.length }
  } finally {
    for (const child of [engine, ...probes]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }

    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('control: a start that runs during the update puts its probe in front of the strict scan as APEX’s own holder', async () => {
  const outcome = await drainThenScan('start')

  assert.equal(outcome.probesDuringUpdate, 1)
  assert.ok(outcome.holders.length > 0, 'the scan must see the probe')
  assert.deepEqual([...new Set(outcome.holders)], ['apex_running'])
}, 30_000)

test('an engine start that waits out the update leaves the strict scan idle and probes once it is released', async () => {
  assert.deepEqual(await drainThenScan('startAfterUpdate'), { holders: [], probesDuringUpdate: 0, probesAfterRelease: 1 })
}, 30_000)
