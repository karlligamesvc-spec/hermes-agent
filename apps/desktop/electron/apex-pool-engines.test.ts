import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  askPoolEngineToRetire,
  MAX_RETIRE_PROBE_FAILURES,
  type PoolEngineEntry,
  poolKeysOnStaleRelayKey,
  reapIdlePoolEngine,
  stampPoolEngine
} from './apex-pool-engines'
import { maskRelayKey } from './apex-relay-key-anchors'

const OLD_KEY = 'sk-old'
const NEW_KEY = 'sk-new'

function spawned(profile: string, key: string | undefined): PoolEngineEntry {
  const entry: PoolEngineEntry = { process: { pid: 1 }, port: 4100, token: 't', lastActiveAt: 0 }
  stampPoolEngine(entry, profile, key)

  return entry
}

describe('restart pooled engines on a new relay key', () => {
  test('stamps the profile and a masked digest, never the key itself', () => {
    const entry = spawned('writer', OLD_KEY)

    assert.equal(entry.apexProfile, 'writer')
    assert.equal(entry.apexRelayKey, maskRelayKey(OLD_KEY))
    assert.ok(!JSON.stringify(entry).includes(OLD_KEY))
    assert.equal(spawned('writer', undefined).apexRelayKey, '')
  })

  test('picks only managed profiles whose live child holds another key', () => {
    const entries: Array<[string, PoolEngineEntry]> = [
      ['writer', spawned('writer', OLD_KEY)],
      ['editor', spawned('editor', NEW_KEY)],
      ['mine', spawned('mine', OLD_KEY)],
      ['local::reviewer', spawned('reviewer', OLD_KEY)],
      ['default', spawned('default', undefined)],
      ['remote', { process: null, apexProfile: 'writer', apexRelayKey: '' }],
      ['unstamped', { process: { pid: 2 } }]
    ]

    assert.deepEqual(poolKeysOnStaleRelayKey(entries, ['default', 'writer', 'editor', 'reviewer'], NEW_KEY), [
      'writer',
      'local::reviewer',
      'default'
    ])
    assert.deepEqual(
      poolKeysOnStaleRelayKey(entries, ['default', 'writer'], undefined),
      [],
      'signed out: nothing to restart for'
    )
  })
})

type Reply = { error: { code?: string; message?: string; statusCode?: number } } | { json: unknown }

function engine(replies: Record<string, Reply>) {
  const calls: Array<Record<string, unknown>> = []

  const post = async (route: string, body: Record<string, unknown>) => {
    assert.equal(route, '/api/health/retirement')
    calls.push(body)
    const reply = replies[String(body.action)]

    if (!reply) {
      throw new Error(`unexpected ${String(body.action)}`)
    }

    if ('error' in reply) {
      throw Object.assign(new Error(reply.error.message || 'failed'), reply.error)
    }

    return reply.json
  }

  return { calls, post }
}

describe('askPoolEngineToRetire', () => {
  test.each([
    [
      'an idle engine commits',
      { prepare: { json: { ok: true, idle: true, token: 'p' } }, commit: { json: { ok: true } } },
      true,
      'committed',
      ['prepare', 'commit']
    ],
    ['a turn in flight keeps it', { prepare: { json: { ok: false, idle: false } } }, false, 'busy', ['prepare']],
    [
      'an undecidable engine keeps it',
      { prepare: { json: { ok: false, idle: null } } },
      false,
      'indeterminate',
      ['prepare']
    ],
    [
      'a prepare without a token keeps it',
      { prepare: { json: { ok: true, idle: true } } },
      false,
      'indeterminate',
      ['prepare']
    ],
    [
      'a lost permit keeps it',
      { prepare: { json: { ok: true, idle: true, token: 'p' } }, commit: { json: { ok: false } } },
      false,
      'commit-refused',
      ['prepare', 'commit']
    ],
    [
      'a failed commit keeps it',
      { prepare: { json: { ok: true, idle: true, token: 'p' } }, commit: { error: { statusCode: 500 } } },
      false,
      'commit-failed: 500',
      ['prepare', 'commit']
    ],
    [
      'an engine without the fence (404) is reaped as before',
      { prepare: { error: { statusCode: 404 } } },
      true,
      'no-fence',
      ['prepare']
    ],
    [
      'an engine without the fence (405) is reaped as before',
      { prepare: { error: { statusCode: 405 } } },
      true,
      'no-fence',
      ['prepare']
    ],
    ['nothing listening is reaped', { prepare: { error: { code: 'ECONNREFUSED' } } }, true, 'unreachable', ['prepare']],
    [
      'a timeout keeps it',
      { prepare: { error: { message: 'Timed out connecting to Hermes backend after 5000ms' } } },
      false,
      'probe-failed: Timed out connecting to Hermes backend after 5000ms',
      ['prepare']
    ],
    ['a 5xx keeps it', { prepare: { error: { statusCode: 503 } } }, false, 'probe-failed: 503', ['prepare']]
  ])('%s', async (_label, replies, retire, reason, actions) => {
    const fake = engine(replies as Record<string, Reply>)

    assert.deepEqual(await askPoolEngineToRetire(fake.post), { retire, reason })
    assert.deepEqual(
      fake.calls.map(call => call.action),
      actions
    )
  })

  test('commits with the token prepare issued', async () => {
    const fake = engine({
      prepare: { json: { ok: true, idle: true, token: 'permit-1' } },
      commit: { json: { ok: true } }
    })

    await askPoolEngineToRetire(fake.post)

    assert.deepEqual(fake.calls[1], { action: 'commit', token: 'permit-1' })
  })

  test('a renderer that came back between prepare and commit cancels the permit instead', async () => {
    const fake = engine({
      prepare: { json: { ok: true, idle: true, token: 'permit-2' } },
      cancel: { json: { ok: true } }
    })

    assert.deepEqual(await askPoolEngineToRetire(fake.post, () => false), { retire: false, reason: 'touched' })
    assert.deepEqual(fake.calls, [{ action: 'prepare' }, { action: 'cancel', token: 'permit-2' }])
  })
})

function reaper(entry: PoolEngineEntry, replies: Record<string, Reply>, pooled = () => true) {
  const fake = engine(replies)
  const lines: string[] = []
  let stops = 0

  const run = () =>
    reapIdlePoolEngine({
      entry,
      label: 'writer',
      idleSeconds: 600,
      post: fake.post,
      stillPooled: pooled,
      stop: () => {
        stops += 1
      },
      log: line => lines.push(line),
      now: () => 1_000_000
    })

  return { calls: fake.calls, lines, run, stops: () => stops }
}

describe('reapIdlePoolEngine', () => {
  test('a turn still running survives the idle window and is asked again one window later', async () => {
    const entry = spawned('writer', NEW_KEY)
    const r = reaper(entry, { prepare: { json: { ok: false, idle: false } } })

    assert.equal(await r.run(), 'kept')
    assert.equal(r.stops(), 0)
    assert.equal(entry.lastActiveAt, 1_000_000)
    assert.deepEqual(r.lines, ['Keeping idle profile backend "writer" another 600s: the engine did not retire (busy)'])
  })

  test('an idle engine is committed, then stopped', async () => {
    const entry = spawned('writer', NEW_KEY)
    const r = reaper(entry, { prepare: { json: { ok: true, idle: true, token: 'p' } }, commit: { json: { ok: true } } })

    assert.equal(await r.run(), 'stopped')
    assert.equal(r.stops(), 1)
    assert.deepEqual(r.lines, ['Reaping idle profile backend "writer" (idle > 600s): committed'])
  })

  test('a remote descriptor or a child that never bound is stopped without asking, as before', async () => {
    for (const entry of [
      { process: null, lastActiveAt: 0 },
      { process: { pid: 3 }, port: null, token: null, lastActiveAt: 0 }
    ]) {
      const r = reaper(entry, {})

      assert.equal(await r.run(), 'stopped')
      assert.deepEqual(r.calls, [])
      assert.deepEqual(r.lines, ['Reaping idle profile backend "writer" (idle > 600s)'])
    }
  })

  test(`unanswered probes are capped at ${MAX_RETIRE_PROBE_FAILURES} so a wedged engine still goes`, async () => {
    const entry = spawned('writer', NEW_KEY)
    const r = reaper(entry, { prepare: { error: { statusCode: 503 } } })
    const outcomes = []

    for (let index = 0; index < MAX_RETIRE_PROBE_FAILURES; index += 1) {
      outcomes.push(await r.run())
    }

    assert.deepEqual(outcomes, [...Array(MAX_RETIRE_PROBE_FAILURES - 1).fill('kept'), 'stopped'])
    assert.equal(r.stops(), 1)
  })

  test('a busy answer resets the unanswered-probe count', async () => {
    const entry = spawned('writer', NEW_KEY)
    entry.apexRetireProbeFailures = MAX_RETIRE_PROBE_FAILURES - 1
    const r = reaper(entry, { prepare: { json: { ok: false, idle: false } } })

    assert.equal(await r.run(), 'kept')
    assert.equal(entry.apexRetireProbeFailures, 0)
  })

  test('an entry that left the pool during the probe is not stopped by the reaper', async () => {
    const entry = spawned('writer', NEW_KEY)

    const r = reaper(
      entry,
      { prepare: { json: { ok: true, idle: true, token: 'p' } }, commit: { json: { ok: true } } },
      () => false
    )

    assert.equal(await r.run(), 'skipped')
    assert.equal(r.stops(), 0)
  })

  test('an engine the renderer touched during a busy probe is left as the renderer set it', async () => {
    const entry = spawned('writer', NEW_KEY)
    const fake = engine({ prepare: { json: { ok: false, idle: false } } })
    let stops = 0

    const outcome = await reapIdlePoolEngine({
      entry,
      label: 'writer',
      idleSeconds: 600,
      post: async (route, body) => {
        entry.lastActiveAt = 42

        return fake.post(route, body)
      },
      stillPooled: () => true,
      stop: () => {
        stops += 1
      },
      log: () => undefined,
      now: () => 1_000_000
    })

    assert.equal(outcome, 'skipped')
    assert.equal(stops, 0)
    assert.equal(entry.lastActiveAt, 42)
  })

  test('a reaper tick during a probe in flight does not probe twice', async () => {
    const entry = spawned('writer', NEW_KEY)
    entry.apexRetiring = true
    const r = reaper(entry, {})

    assert.equal(await r.run(), 'skipped')
    assert.deepEqual(r.calls, [])
  })
})
