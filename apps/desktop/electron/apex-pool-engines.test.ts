import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { parsePoolAllBusy, POOL_ALL_BUSY_CODE } from '../shared/apex-pool-busy'

import {
  askPoolEngineToRetire,
  makeRoomInPool,
  MAX_RETIRE_PROBE_FAILURES,
  poolAllBusyError,
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

// hc-1080, several assistants on: a user opens one more assistant than the pool holds.
describe('makeRoomInPool', () => {
  const IDLE = { prepare: { json: { ok: true, idle: true, token: 'p' } }, commit: { json: { ok: true } } }
  const BUSY = { prepare: { json: { ok: false, idle: false } } }

  function pool(specs: Array<[string, number, Record<string, Reply> | 'starting']>) {
    const entries = new Map<string, PoolEngineEntry>()
    const fakes = new Map<PoolEngineEntry, ReturnType<typeof engine>>()

    for (const [profile, lastActiveAt, replies] of specs) {
      const entry = spawned(profile, NEW_KEY)
      entry.lastActiveAt = lastActiveAt

      if (replies === 'starting') {
        entry.port = null
        entry.token = null
      }

      entries.set(profile, entry)
      fakes.set(entry, engine(replies === 'starting' ? {} : replies))
    }

    const stopped: string[] = []
    const lines: string[] = []

    const run = (keep: number) =>
      makeRoomInPool({
        entries: entries.entries(),
        keep,
        post: entry => fakes.get(entry)!.post,
        stillPooled: (key, entry) => entries.get(key) === entry,
        stop: async key => {
          stopped.push(key)
          entries.delete(key)
        },
        log: line => lines.push(line)
      })

    const asked = () => [...fakes.entries()].filter(([, fake]) => fake.calls.length).map(([entry]) => entry.apexProfile)

    return { asked, entries, lines, run, stopped }
  }

  test('a pool with room asks nobody', async () => {
    const p = pool([
      ['writer', 1, IDLE],
      ['editor', 2, IDLE]
    ])

    assert.deepEqual(await p.run(2), { room: true, evicted: [], busy: [] })
    assert.deepEqual(p.asked(), [])
    assert.deepEqual(p.lines, [])
  })

  test('the least recently used idle engine goes, even one pinged seconds ago', async () => {
    const p = pool([
      ['editor', 200, IDLE],
      ['writer', 100, IDLE],
      ['maxer', 300, IDLE]
    ])

    assert.deepEqual(await p.run(2), { room: true, evicted: ['writer'], busy: [] })
    assert.deepEqual(p.stopped, ['writer'])
    assert.deepEqual(p.asked(), ['writer'], 'stops asking once there is room')
    assert.match(p.lines[0], /^Evicting profile backend "writer" to make room for another assistant \(committed\)$/)
  })

  test('an engine mid-turn is skipped for the next least recently used one', async () => {
    const p = pool([
      ['writer', 100, BUSY],
      ['editor', 200, IDLE],
      ['maxer', 300, IDLE]
    ])

    assert.deepEqual(await p.run(2), { room: true, evicted: ['editor'], busy: ['writer'] })
    assert.ok(p.entries.has('writer'), 'the turn keeps running')
  })

  test('every engine working: no room, nothing stopped, and the busy ones by name', async () => {
    const p = pool([
      ['writer', 100, BUSY],
      ['editor', 200, 'starting'],
      ['maxer', 300, BUSY]
    ])

    assert.deepEqual(await p.run(2), { room: false, evicted: [], busy: ['writer', 'editor', 'maxer'] })
    assert.deepEqual(p.stopped, [])
    assert.deepEqual(p.asked(), ['writer', 'maxer'], 'an engine still starting is never asked')
    assert.deepEqual(p.lines, ['No room for another assistant: every pooled engine is working (writer, editor, maxer)'])
  })

  test('several over the limit (the limit was lowered): as many as needed go', async () => {
    const p = pool([
      ['writer', 100, IDLE],
      ['editor', 200, BUSY],
      ['maxer', 300, IDLE],
      ['fourth', 400, IDLE]
    ])

    assert.deepEqual(await p.run(1), { room: true, evicted: ['writer', 'maxer', 'fourth'], busy: ['editor'] })
  })

  test('an engine without the fence goes as before; one that cannot answer stays', async () => {
    const p = pool([
      ['writer', 100, { prepare: { error: { statusCode: 503 } } }],
      ['editor', 200, { prepare: { error: { statusCode: 404 } } }]
    ])

    assert.deepEqual(await p.run(1), { room: true, evicted: ['editor'], busy: ['writer'] })
  })

  test('remote descriptors hold no engine and are never counted or asked', async () => {
    const p = pool([['writer', 100, IDLE]])
    p.entries.set('remote', { process: null, lastActiveAt: 0 })

    assert.deepEqual(await p.run(1), { room: true, evicted: [], busy: [] })
  })

  test('an engine the renderer opens during the probe keeps its permit cancelled and stays', async () => {
    const p = pool([
      ['writer', 100, { ...IDLE, cancel: { json: { ok: true } } }],
      ['editor', 200, BUSY]
    ])

    const writer = p.entries.get('writer')!
    const original = writer.lastActiveAt

    const result = await makeRoomInPool({
      entries: p.entries.entries(),
      keep: 1,
      post: entry => async (route, body) => {
        if (entry === writer && body.action === 'prepare') {
          writer.lastActiveAt = (original || 0) + 1
        }

        return entry === writer ? (body.action === 'prepare' ? IDLE.prepare.json : { ok: true }) : BUSY.prepare.json
      },
      stillPooled: (key, entry) => p.entries.get(key) === entry,
      stop: async key => {
        p.stopped.push(key)
      },
      log: () => undefined
    })

    assert.deepEqual(result, { room: false, evicted: [], busy: ['writer', 'editor'] })
    assert.deepEqual(p.stopped, [])
  })

  test('an engine stopped elsewhere during the probe frees its slot without a second stop', async () => {
    const p = pool([
      ['writer', 100, BUSY],
      ['editor', 200, IDLE]
    ])

    const result = await makeRoomInPool({
      entries: p.entries.entries(),
      keep: 1,
      post: entry => async () => {
        p.entries.delete(entry.apexProfile!)

        return { ok: false, idle: false }
      },
      stillPooled: (key, entry) => p.entries.get(key) === entry,
      stop: async key => {
        p.stopped.push(key)
      },
      log: () => undefined
    })

    assert.deepEqual(result, { room: true, evicted: [], busy: [] })
    assert.deepEqual(p.stopped, [])
  })
})

describe('the all-busy result the renderer reads (shared/apex-pool-busy.ts)', () => {
  test('travels in the error message, through Electron IPC wrapping, back to the same object', () => {
    const error = poolAllBusyError({ room: false, evicted: [], busy: ['writer', 'editor', 'maxer'] }, 3)
    const wrapped = new Error(`Error invoking remote method 'hermes:connection': Error: ${error.message}`)

    // The literal is the contract quoted to hc-1077 and in desktop.log; keep it stable.
    assert.equal(POOL_ALL_BUSY_CODE, 'APEX_POOL_ALL_BUSY')
    assert.equal(error.message, 'APEX_POOL_ALL_BUSY {"busy":["writer","editor","maxer"],"limit":3}')
    assert.deepEqual(parsePoolAllBusy(error), { busy: ['writer', 'editor', 'maxer'], limit: 3 })
    assert.deepEqual(parsePoolAllBusy(wrapped), { busy: ['writer', 'editor', 'maxer'], limit: 3 })
    assert.deepEqual(parsePoolAllBusy(wrapped.message), { busy: ['writer', 'editor', 'maxer'], limit: 3 })
  })

  test.each([
    ['another failure', new Error('Local backend start for "x" timed out while waiting for a free slot.')],
    ['a broken payload', new Error(`${POOL_ALL_BUSY_CODE} {not json}`)],
    ['not an error', 42]
  ])('is null for %s', (_label, value) => {
    assert.equal(parsePoolAllBusy(value), null)
  })
})
