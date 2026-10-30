// hc-1106: a running engine keeps the relay key it was spawned with. After a
// re-login (the server rotates the key) or a 401 whose stored key is valid, the
// primary engine, pooled engines and the messaging gateway still on the old key
// restart once idle — never in the middle of a turn.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import {
  gatewayIdleVerdict,
  gatewayKeyHolder,
  gatewayStatePath,
  holdsRelayKey,
  poolKeyHolders,
  primaryKeyHolder,
  reconcileRelayKeyAndEngines,
  type RelayKeyHolder,
  STALE_KEY_RETRY_MS,
  StaleRelayKeyRestarts,
  stampKeyHolderProcess
} from './apex-engine-relay-key'
import { managedModelConfigYaml } from './apex-managed'
import { type PoolEngineEntry, stampPoolEngine } from './apex-pool-engines'
import { maskRelayKey } from './apex-relay-key-anchors'

const OLD_KEY = 'sk-yOLDoldoldoldold47f8'
const NEW_KEY = 'sk-yNEWnewnewnewnew3382'

/** An engine behind the retirement fence (hermes_cli/backend_retirement.py): idle commits, busy refuses. */
function fencedEngine(state: { busy: boolean }) {
  const actions: string[] = []

  const post = async (route: string, body: Record<string, unknown>) => {
    assert.equal(route, '/api/health/retirement')
    actions.push(String(body.action))

    if (body.action === 'prepare') {
      return state.busy ? { ok: false, idle: false } : { ok: true, idle: true, token: 'permit' }
    }

    return { ok: true }
  }

  return { actions, post }
}

/** main.ts's primary: a live process slot, re-homed by tearing it down and spawning under the stored key. */
function primary(profile: string, spawnedWith: null | string, state = { busy: false }) {
  const engine = fencedEngine(state)
  const slot: { process: null | object } = { process: { pid: 91265 } }
  let storedKey = spawnedWith
  let restarts = 0
  stampKeyHolderProcess(slot.process, spawnedWith)

  const holders = () =>
    primaryKeyHolder(() => slot.process, profile, {
      post: engine.post,
      restart: async () => {
        restarts += 1
        slot.process = { pid: 91265 + restarts }
        stampKeyHolderProcess(slot.process, storedKey)
      }
    })

  return {
    engine,
    holders,
    slot,
    state,
    get restarts() {
      return restarts
    },
    store(key: null | string) {
      storedKey = key
    }
  }
}

function restarter(holders: () => RelayKeyHolder[], relayKey: () => null | string) {
  const log: string[] = []
  const timers: Array<() => void> = []

  const restarts = new StaleRelayKeyRestarts({
    holders,
    relayKey,
    log: line => log.push(line),
    setTimer: (run, ms) => {
      assert.equal(ms, STALE_KEY_RETRY_MS)
      timers.push(run)
    }
  })

  return { log, restarts, timers }
}

describe('the primary engine follows a re-login', () => {
  test('a primary spawned with the old key restarts once idle after the key rotates', async () => {
    const apex = primary('default', OLD_KEY)
    apex.store(NEW_KEY)
    const { log, restarts } = restarter(apex.holders, () => NEW_KEY)

    assert.deepEqual(await restarts.run('managed-runtime-complete'), {
      restarted: ['primary backend "default"'],
      waiting: []
    })
    assert.equal(apex.restarts, 1)
    assert.deepEqual(apex.engine.actions, ['prepare', 'commit'], 'asked through the retirement fence first')
    assert.deepEqual(
      apex.holders().map(holder => holder.stamp),
      [maskRelayKey(NEW_KEY)],
      'its successor runs on the new key'
    )
    assert.ok(
      log.every(line => !line.includes(OLD_KEY) && !line.includes(NEW_KEY)),
      'no key in the log'
    )
  })

  // The case the M7 acceptance found: with several assistants the primary serves the one pinned
  // last time (PrimaryProfilePin), not APEX; hc-1080's pool restart never saw it.
  test('a primary serving a named assistant restarts the same way', async () => {
    const editor = primary('apex-bot-2', OLD_KEY)
    editor.store(NEW_KEY)
    const { restarts } = restarter(editor.holders, () => NEW_KEY)

    assert.deepEqual((await restarts.run('managed-runtime-complete')).restarted, ['primary backend "apex-bot-2"'])
    assert.equal(editor.restarts, 1)
  })

  test('one assistant: the primary is the only engine, and it alone restarts', async () => {
    const apex = primary('default', OLD_KEY)
    apex.store(NEW_KEY)
    const pool = new Map<string, PoolEngineEntry>()

    const { restarts } = restarter(
      () => [
        ...poolKeyHolders(pool.entries(), {
          post: () => assert.fail('no pooled engine to ask'),
          stillPooled: () => true,
          stop: async () => assert.fail('no pooled engine to stop')
        }),
        ...apex.holders()
      ],
      () => NEW_KEY
    )

    assert.deepEqual(await restarts.run('managed-runtime-complete'), {
      restarted: ['primary backend "default"'],
      waiting: []
    })
  })

  test('a primary already on the stored key is left alone', async () => {
    const apex = primary('default', NEW_KEY)
    const { restarts } = restarter(apex.holders, () => NEW_KEY)

    assert.deepEqual(await restarts.run('managed-runtime-complete'), { restarted: [], waiting: [] })
    assert.deepEqual(apex.engine.actions, [], 'not even asked')
  })

  test('a turn in flight is never cut off: the primary waits, is asked again, and restarts once idle', async () => {
    const apex = primary('default', OLD_KEY, { busy: true })
    apex.store(NEW_KEY)
    const { log, restarts, timers } = restarter(apex.holders, () => NEW_KEY)

    assert.deepEqual(await restarts.run('managed-runtime-complete'), {
      restarted: [],
      waiting: ['primary backend "default"']
    })
    assert.equal(apex.restarts, 0)
    assert.deepEqual(apex.engine.actions, ['prepare'], 'a busy engine is not committed')
    assert.equal(timers.length, 1, 'asked again later')

    // Still busy on the first retry: one log line for the whole wait, one timer at a time.
    timers.shift()?.()
    await restarts.run('settle')
    assert.equal(apex.restarts, 0)
    assert.equal(log.filter(line => line.includes('still holds the previous relay key')).length, 1)
    assert.equal(timers.length, 1)

    apex.state.busy = false
    timers.shift()?.()
    await restarts.run('settle')
    assert.equal(apex.restarts, 1)
    assert.equal(timers.length, 0, 'nothing left to wait for')
  })

  test('a primary replaced while it was asked is not restarted again', async () => {
    const apex = primary('default', OLD_KEY)
    apex.store(NEW_KEY)

    const holders = () =>
      apex.holders().map(holder => ({
        ...holder,
        retire: async () => {
          const verdict = await holder.retire()
          // A profile switch or crash recovery spawned a new primary meanwhile.
          apex.slot.process = { pid: 1 }

          return verdict
        }
      }))

    const { restarts } = restarter(holders, () => NEW_KEY)

    assert.deepEqual(await restarts.run('managed-runtime-complete'), { restarted: [], waiting: [] })
    assert.equal(apex.restarts, 0)
  })

  // hc-1114: the server revoked the key; a process that keeps it still holds a credential on this computer.
  test('signed out: a primary still on the revoked key restarts once idle, onto none', async () => {
    const apex = primary('default', OLD_KEY)
    apex.store(null)
    const { log, restarts } = restarter(apex.holders, () => null)

    assert.deepEqual(await restarts.run('sign-out'), { restarted: ['primary backend "default"'], waiting: [] })
    assert.deepEqual(apex.engine.actions, ['prepare', 'commit'], 'asked through the retirement fence first')
    assert.deepEqual(
      apex.holders().map(holder => holder.stamp),
      [''],
      'its successor holds no key'
    )
    assert.deepEqual(log, [
      '[apexnodes] restarting primary backend "default" so it no longer holds the revoked relay key (sign-out; committed)'
    ])

    assert.deepEqual(
      await restarts.run('sign-out'),
      { restarted: [], waiting: [] },
      'a primary on no key is left alone'
    )
    assert.equal(apex.restarts, 1)
  })

  test('signed out during a turn: the primary keeps the turn and restarts when it ends', async () => {
    const apex = primary('apex-bot-2', OLD_KEY, { busy: true })
    apex.store(null)
    const { log, restarts, timers } = restarter(apex.holders, () => '')

    assert.deepEqual((await restarts.run('sign-out')).waiting, ['primary backend "apex-bot-2"'])
    assert.equal(apex.restarts, 0)
    assert.ok(log[0].includes('still holds the previous relay key; restarting it once idle (busy'), log[0])

    apex.state.busy = false
    timers.shift()?.()
    await restarts.run('settle', true)
    assert.equal(apex.restarts, 1)
  })

  test('a wait that began before the sign-out goes on after it', async () => {
    const apex = primary('default', OLD_KEY, { busy: true })
    let stored: null | string = NEW_KEY
    apex.store(NEW_KEY)
    const { restarts, timers } = restarter(apex.holders, () => stored)

    assert.deepEqual((await restarts.run('managed-runtime-complete')).waiting, ['primary backend "default"'])

    stored = null
    apex.store(null)
    apex.state.busy = false
    timers.shift()?.()
    await restarts.run('settle', true)

    assert.equal(apex.restarts, 1)
    assert.deepEqual(
      apex.holders().map(holder => holder.stamp),
      ['']
    )
  })

  // A fresh install launches signed out; its first sign-in and a later re-login happen in the same run.
  test('a primary spawned signed out adopts the first key without a restart, then follows the next change', async () => {
    const apex = primary('default', null)
    let stored = OLD_KEY
    const { log, restarts } = restarter(apex.holders, () => stored)

    assert.deepEqual(await restarts.run('managed-runtime-complete'), { restarted: [], waiting: [] })
    assert.equal(apex.restarts, 0)
    assert.deepEqual(apex.engine.actions, [], 'not asked: nothing it built holds an older relay key')
    assert.deepEqual(
      apex.holders().map(holder => holder.stamp),
      [maskRelayKey(OLD_KEY)]
    )
    assert.ok(log.some(line => line.includes('was started signed out')))

    stored = NEW_KEY
    apex.store(NEW_KEY)
    assert.deepEqual((await restarts.run('managed-runtime-complete')).restarted, ['primary backend "default"'])
    assert.equal(apex.restarts, 1)
  })

  // reloadBackendForRelayKey skips a re-provision's second re-home on this (wiring test).
  test('holdsRelayKey is true only for the key the process was stamped with or adopted', () => {
    const child = { pid: 1 }
    stampKeyHolderProcess(child, OLD_KEY)

    assert.deepEqual(
      [
        holdsRelayKey(child, OLD_KEY),
        holdsRelayKey(child, NEW_KEY),
        holdsRelayKey(child, null),
        holdsRelayKey(null, OLD_KEY)
      ],
      [true, false, false, false]
    )
    assert.equal(holdsRelayKey({ pid: 2 }, OLD_KEY), false, 'an unstamped process holds nothing we know of')
  })

  test('the stamp is a fingerprint, never the key', () => {
    const apex = primary('default', OLD_KEY)
    const [holder] = apex.holders()

    assert.ok(holder.stamp && !holder.stamp.includes(OLD_KEY.slice(4)))
  })

  test('overlapping runs ask and restart the primary once', async () => {
    const apex = primary('default', OLD_KEY)
    apex.store(NEW_KEY)
    const { restarts } = restarter(apex.holders, () => NEW_KEY)

    const [first, second] = await Promise.all([restarts.run('managed-runtime-complete'), restarts.run('relay-401')])

    assert.deepEqual(first.restarted, ['primary backend "default"'])
    assert.deepEqual(second.restarted, [])
    assert.equal(apex.restarts, 1)
  })

  test('one holder failing to restart does not stop the others', async () => {
    const broken: RelayKeyHolder = {
      label: 'profile backend "broken"',
      stamp: maskRelayKey(OLD_KEY),
      retire: async () => ({ retire: true, reason: 'committed' }),
      current: () => true,
      restart: async () => {
        throw new Error('spawn failed')
      }
    }

    const apex = primary('default', OLD_KEY)
    apex.store(NEW_KEY)

    const { log, restarts } = restarter(
      () => [broken, ...apex.holders()],
      () => NEW_KEY
    )

    assert.deepEqual((await restarts.run('managed-runtime-complete')).restarted, ['primary backend "default"'])
    assert.ok(log.some(line => line.includes('restarting profile backend "broken" failed: spawn failed')))
  })

  test('the retries stop after the cap; the next key check starts over', async () => {
    const apex = primary('default', OLD_KEY, { busy: true })
    apex.store(NEW_KEY)
    const log: string[] = []
    const timers: Array<() => void> = []

    const restarts = new StaleRelayKeyRestarts({
      holders: apex.holders,
      relayKey: () => NEW_KEY,
      log: line => log.push(line),
      maxRetries: 2,
      setTimer: run => timers.push(run)
    })

    await restarts.run('managed-runtime-complete')

    for (let round = 0; round < 3 && timers.length; round += 1) {
      timers.shift()?.()
      // Queued behind the timer's own retry run, so awaiting it settles that run too.
      await restarts.run('settle', true)
    }

    assert.equal(timers.length, 0)
    assert.ok(log.some(line => line.includes('stopped waiting for primary backend "default"')))

    await restarts.run('relay-401')
    assert.equal(timers.length, 1, 'a fresh key check waits again')
  })
})

describe('pooled engines (hc-1080) restart once idle, every local one', () => {
  function pooled(profile: string, key: string | undefined, extra: Partial<PoolEngineEntry> = {}): PoolEngineEntry {
    const entry: PoolEngineEntry = { process: { pid: 7 }, port: 4100, token: 't', lastActiveAt: 0, ...extra }
    stampPoolEngine(entry, profile, key)

    return entry
  }

  test('picks every local child on another key, a BYOK profile too, and skips remote and unstamped ones', async () => {
    const pool = new Map<string, PoolEngineEntry>([
      ['writer', pooled('writer', OLD_KEY)],
      ['editor', pooled('editor', NEW_KEY)],
      // A BYOK profile's engine still carries the platform-tool key in its env.
      ['mine', pooled('mine', OLD_KEY)],
      ['default', pooled('default', undefined)],
      ['remote', { process: null, apexProfile: 'writer', apexRelayKey: '' }],
      ['unstamped', { process: { pid: 2 } }]
    ])

    const stopped: string[] = []

    const { restarts } = restarter(
      () =>
        poolKeyHolders(pool.entries(), {
          post: () => fencedEngine({ busy: false }).post,
          stillPooled: (key, entry) => pool.get(key) === entry,
          stop: async key => {
            stopped.push(key)
            pool.delete(key)
          }
        }),
      () => NEW_KEY
    )

    const result = await restarts.run('managed-runtime-complete')

    // hc-1080's rule kept: an engine spawned signed out ('default') restarts after sign-in.
    assert.deepEqual(stopped, ['writer', 'mine', 'default'])
    assert.deepEqual(result.waiting, [])
  })

  test('signed out (hc-1114): every pooled engine on a key stops; one spawned signed out stays', async () => {
    const pool = new Map<string, PoolEngineEntry>([
      ['writer', pooled('writer', OLD_KEY)],
      ['default', pooled('default', undefined)]
    ])

    const stopped: string[] = []

    const { restarts } = restarter(
      () =>
        poolKeyHolders(pool.entries(), {
          post: () => fencedEngine({ busy: false }).post,
          stillPooled: (key, entry) => pool.get(key) === entry,
          stop: async key => {
            stopped.push(key)
            pool.delete(key)
          }
        }),
      () => null
    )

    assert.deepEqual((await restarts.run('sign-out')).restarted, ['profile backend "writer"'])
    assert.deepEqual(stopped, ['writer'])
  })

  test('a busy pooled engine keeps its turn; one the reaper is asking waits too', async () => {
    const busy = pooled('writer', OLD_KEY)
    const reaping = pooled('editor', OLD_KEY, { apexRetiring: true })
    const starting = pooled('reviewer', OLD_KEY, { port: null })

    const pool = new Map<string, PoolEngineEntry>([
      ['writer', busy],
      ['editor', reaping],
      ['reviewer', starting]
    ])

    const { restarts } = restarter(
      () =>
        poolKeyHolders(pool.entries(), {
          post: () => fencedEngine({ busy: true }).post,
          stillPooled: (key, entry) => pool.get(key) === entry,
          stop: async () => assert.fail('nothing may stop')
        }),
      () => NEW_KEY
    )

    const result = await restarts.run('managed-runtime-complete')

    assert.deepEqual(result.waiting, [
      'profile backend "writer"',
      'profile backend "editor"',
      'profile backend "reviewer"'
    ])
    assert.equal(busy.apexRetiring, false, 'the probe flag is released')
    assert.equal(reaping.apexRetiring, true, "the reaper's flag is left to the reaper")
  })
})

describe('the messaging gateway', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ['no agent at work', '{"gateway_state":"running","active_agents":0}', true, 'idle'],
    ['an IM turn in flight', '{"gateway_state":"running","active_agents":2}', false, 'busy (2 active)'],
    ['a count it cannot read', '{"gateway_state":"running"}', false, 'indeterminate'],
    ['a torn file', '{"gateway_', false, 'unreadable-state']
  ])('%s', (_label, raw, retire, reason) => {
    assert.deepEqual(
      gatewayIdleVerdict(() => raw),
      { retire, reason }
    )
  })

  test('a gateway that has not written its state yet has served nothing', () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

    assert.deepEqual(
      gatewayIdleVerdict(() => {
        throw missing
      }),
      { retire: true, reason: 'no-state' }
    )
  })

  test('a gateway spawned signed out holds nothing that can go stale', () => {
    const child = { pid: 4244 }
    stampKeyHolderProcess(child, null)

    assert.deepEqual(
      gatewayKeyHolder(() => child, '/unused', { restart: async () => assert.fail('never restarted') }),
      []
    )
  })

  test('signed out (hc-1114): a gateway spawned with a key restarts once idle, onto none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1114-gateway-'))
    directories.push(root)
    const statePath = gatewayStatePath(root, null)
    fs.writeFileSync(statePath, JSON.stringify({ gateway_state: 'running', active_agents: 0 }))
    const slot: { process: null | object } = { process: { pid: 5150 } }
    stampKeyHolderProcess(slot.process, OLD_KEY)

    const { restarts } = restarter(
      () =>
        gatewayKeyHolder(() => slot.process, statePath, {
          restart: async () => {
            slot.process = { pid: 5151 }
            stampKeyHolderProcess(slot.process, null)
          }
        }),
      () => null
    )

    assert.deepEqual((await restarts.run('sign-out')).restarted, ['messaging gateway'])
    assert.deepEqual((await restarts.run('sign-out')).restarted, [], 'its successor holds no key')
  })

  test('reads the state of the profile it serves', () => {
    assert.equal(gatewayStatePath('/h', null), path.join('/h', 'gateway_state.json'))
    assert.equal(gatewayStatePath('/h', 'default'), path.join('/h', 'gateway_state.json'))
    assert.equal(gatewayStatePath('/h', 'apex-bot-2'), path.join('/h', 'profiles', 'apex-bot-2', 'gateway_state.json'))
  })

  test('a gateway spawned with the old key restarts when idle and waits while an IM turn runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1106-gateway-'))
    directories.push(root)
    const statePath = gatewayStatePath(root, null)
    fs.writeFileSync(statePath, JSON.stringify({ gateway_state: 'running', active_agents: 1 }))
    const slot: { process: null | object } = { process: { pid: 4242 } }
    stampKeyHolderProcess(slot.process, OLD_KEY)
    let restarts = 0

    const { restarts: runner } = restarter(
      () =>
        gatewayKeyHolder(() => slot.process, statePath, {
          restart: async () => {
            restarts += 1
            slot.process = { pid: 4243 }
            stampKeyHolderProcess(slot.process, NEW_KEY)
          }
        }),
      () => NEW_KEY
    )

    assert.deepEqual((await runner.run('managed-runtime-complete')).waiting, ['messaging gateway'])
    assert.equal(restarts, 0)

    fs.writeFileSync(statePath, JSON.stringify({ gateway_state: 'running', active_agents: 0 }))
    assert.deepEqual((await runner.run('retry')).restarted, ['messaging gateway'])
    assert.equal(restarts, 1)
  })
})

describe('the 401 self-heal compares the running engine, not only the key on disk', () => {
  const directories: string[] = []
  const baseUrl = 'https://example.invalid/relay/v1'

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  // After a re-login config.yaml and the stored credential both hold the new key, so the
  // relay probe passes and reconcileManagedRelayKey alone finds nothing to heal.
  function healedDisk(probeStatus: number) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1106-heal-'))
    directories.push(directory)
    const config = path.join(directory, 'config.yaml')

    fs.writeFileSync(
      config,
      managedModelConfigYaml({
        provider: 'custom',
        default: 'fixture-model',
        api_key: NEW_KEY,
        base_url: baseUrl,
        custom_providers: [{ name: 'fixture', api_key: NEW_KEY, base_url: baseUrl, model: 'fixture-model' }]
      })
    )
    const applied: string[] = []

    return {
      applied,
      deps: {
        enabled: true,
        storedKey: NEW_KEY,
        baseUrl,
        hasToken: true,
        readConfig: () => fs.readFileSync(config, 'utf8'),
        writeConfig: (next: string) => fs.writeFileSync(config, next),
        probeRelay: async (key: string) => {
          assert.equal(key, NEW_KEY, 'the self-heal probes the stored key')

          return { ok: probeStatus === 200, statusCode: probeStatus }
        },
        provisionKey: async () => ({ apiKey: 'sk-minted' }),
        applyToBackend: async (reason: string) => {
          applied.push(reason)
        }
      }
    }
  }

  test('a valid key on disk with a primary still on the old one restarts the primary', async () => {
    const apex = primary('default', OLD_KEY)
    apex.store(NEW_KEY)
    const { restarts } = restarter(apex.holders, () => NEW_KEY)
    const disk = healedDisk(200)

    const outcome = await reconcileRelayKeyAndEngines(disk.deps, reason => restarts.run(reason))

    // completeRuntime: main completes the managed runtime on the restarted engine, so the renderer
    // gets an assignment back and retries the failed turn there.
    assert.deepEqual(
      {
        probeStatus: outcome.probeStatus,
        relayUnauthorized: outcome.relayUnauthorized,
        enginesRestarted: outcome.enginesRestarted,
        completeRuntime: outcome.completeRuntime
      },
      {
        probeStatus: 'ok',
        relayUnauthorized: false,
        enginesRestarted: ['primary backend "default"'],
        completeRuntime: true
      }
    )
    assert.equal(apex.restarts, 1)
    assert.deepEqual(disk.applied, [], 'no key drift, no unconditional reload')
  })

  test('a valid key on disk with every engine on it restarts nothing', async () => {
    const apex = primary('default', NEW_KEY)
    const { restarts } = restarter(apex.holders, () => NEW_KEY)

    const outcome = await reconcileRelayKeyAndEngines(healedDisk(200).deps, reason => restarts.run(reason))

    assert.deepEqual(outcome.enginesRestarted, [])
    assert.equal(outcome.completeRuntime, false, 'nothing to retry the turn on')
    assert.equal(apex.restarts, 0)
  })

  test('a runtime still pending is completed as before, restarted engine or not', async () => {
    const apex = primary('default', NEW_KEY)
    const { restarts } = restarter(apex.holders, () => NEW_KEY)

    const run = (status: number) =>
      reconcileRelayKeyAndEngines(
        healedDisk(status).deps,
        reason => restarts.run(reason),
        () => true
      )

    assert.equal((await run(200)).completeRuntime, true)
    assert.equal((await run(401)).completeRuntime, true, 'healed: probe ok after the re-provision')
    assert.equal((await run(503)).completeRuntime, false)
  })

  test.each([
    ['the relay rejects the stored key (re-provisioned and reloaded instead)', 401],
    ['the relay is down', 503]
  ])('%s: the stale-engine check does not run', async (_label, status) => {
    let asked = 0

    const outcome = await reconcileRelayKeyAndEngines(healedDisk(status).deps, async () => {
      asked += 1

      return { restarted: ['x'], waiting: [] }
    })

    assert.equal(asked, 0)
    assert.deepEqual(outcome.enginesRestarted, [])
  })

  test('an account switch during the heal reports nothing restarted', async () => {
    let current = true
    const disk = healedDisk(200)

    const outcome = await reconcileRelayKeyAndEngines({ ...disk.deps, isCurrent: () => current }, async () => {
      current = false

      return { restarted: ['primary backend "default"'], waiting: [] }
    })

    assert.deepEqual(outcome.enginesRestarted, [])
  })
})
