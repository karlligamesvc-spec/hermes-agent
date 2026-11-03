// hc-1093: with several assistants on, opening one more assistant than the
// pool holds must make room at once (hc-1080 makeRoomInPool) even when a
// background dial for that assistant reached main first and owns the dial
// claim. 0.17.66 (hc-1083 M7): the user's foreground dial joined the claim,
// only promoted the queued slot request, and waited out the 30 s slot wait.
//
// main.ts cannot be imported, so `pool()` wires the real claim, slot
// coordinator, upstream LRU eviction and makeRoomInPool the way main.ts does
// (each piece names the main.ts function it stands for); the coordinator
// wiring itself is pinned in apex-profile-wiring.test.ts.

import assert from 'node:assert/strict'

import { afterEach, beforeEach, describe, test, vi } from 'vitest'

import { parsePoolAllBusy } from '../shared/apex-pool-busy'

import { makeRoomInPool, poolAllBusyError, type PoolEngineEntry, reapIdlePoolEngine } from './apex-pool-engines'
import { BackendDialClaims } from './backend-dial-claim'
import { evictPoolEntries } from './pool-eviction'
import {
  LocalBackendSpawnCoordinator,
  type LocalBackendSpawnPriority,
  type LocalBackendSpawnRequest,
  type ReleaseLocalBackendSlot
} from './pool-spawn-coordinator'

const LIMIT = 3 // pool-limits.ts maxBackends
const SLOT_WAIT_MS = 30_000 // main.ts POOL_SLOT_WAIT_MS
const FRESH_MS = 4 * 60_000 // main.ts POOL_KEEPALIVE_FRESH_MS

type Engine = 'busy' | 'idle'

interface Entry extends PoolEngineEntry {
  connection?: Promise<string>
  release?: ReleaseLocalBackendSlot
  request?: LocalBackendSpawnRequest | null
  spawnPriority: LocalBackendSpawnPriority
}

/** Engines already running, least recently used first; each was pinged `pingedAgoMs` ago. */
function pool(running: Array<[string, Engine]>, { multiBot = true, pingedAgoMs = 30_000 } = {}) {
  const entries = new Map<string, Entry>()
  const engines = new Map<string, Engine>(running)
  const asked: string[] = []
  const stopped: string[] = []
  const log: string[] = []
  const pendingForeground = new Set<string>() // main.ts pendingForegroundSpawns
  const claims = new BackendDialClaims() // main.ts backendDialClaims

  // main.ts stopPoolBackend: the slot is free only once the child has exited.
  async function stop(key: string): Promise<void> {
    const entry = entries.get(key)

    entries.delete(key)
    stopped.push(key)
    await Promise.resolve()
    entry?.release?.()
  }

  // An engine's /api/health/retirement: a busy one (a turn, or since hc-1102 a background command) refuses.
  const post = (entry: PoolEngineEntry) => async (_route: string, body: Record<string, unknown>) => {
    asked.push(`${entry.apexProfile}:${body.action}`)

    return engines.get(entry.apexProfile!) === 'idle'
      ? body.action === 'prepare'
        ? { ok: true, idle: true, token: 'permit' }
        : { ok: true }
      : { ok: false, idle: false }
  }

  // main.ts evictLruPoolBackends.
  async function evict(keep: number, priority?: LocalBackendSpawnPriority): Promise<unknown> {
    if (priority === 'foreground' && multiBot) {
      const made = await makeRoomInPool({
        entries: entries.entries(),
        keep,
        log: line => log.push(line),
        stop,
        post,
        stillPooled: (key, entry) => entries.get(key) === entry
      })

      if (!made.room) {
        throw poolAllBusyError(made, LIMIT)
      }

      return made.evicted
    }

    // main.ts poolRetirement: the LRU cap asks the engine first, as the idle reaper does (hc-1102).
    return evictPoolEntries(entries.entries(), keep, Date.now(), FRESH_MS, async key => {
      const entry = entries.get(key)!

      await reapIdlePoolEngine({
        entry,
        idleSeconds: 600,
        label: key,
        log: line => log.push(line),
        post: post(entry),
        stillPooled: () => entries.get(key) === entry,
        stop: () => stop(key),
        what: `Evicting idle profile backend "${key}" (LRU cap ${LIMIT})`
      })
    })
  }

  // main.ts localBackendSpawnCoordinator, wired as there.
  const coordinator = new LocalBackendSpawnCoordinator(LIMIT, {
    onForegroundWait: () => multiBot && evict(LIMIT - 1, 'foreground')
  })

  // main.ts promotePoolEntry.
  function promote(entry: Entry): void {
    entry.spawnPriority = 'foreground'
    entry.request?.promote('foreground')
  }

  // main.ts runPoolBackendStart, up to the child taking its slot.
  async function start(key: string, entry: Entry): Promise<string> {
    await Promise.resolve() // reapOrphanedBackendsOnce / resolveRemoteBackend

    if (pendingForeground.delete(key)) {
      entry.spawnPriority = 'foreground'
    }

    const request = coordinator.request(key, { timeoutMs: SLOT_WAIT_MS, priority: entry.spawnPriority })
    entry.request = request

    if (request.queued) {
      log.push(
        `Profile backend "${key}" waiting for a free local slot (${coordinator.activeCount}/${LIMIT} busy, ${coordinator.queuedCount} queued)`
      )
    }

    entry.release = await request.acquired
    entry.request = null
    Object.assign(entry, { process: { pid: 1 }, port: 4100, token: 't' })
    engines.set(key, 'idle')

    return `engine:${key}`
  }

  // main.ts ensureBackend, pooled-profile branch.
  async function ensure(key: string, priority: LocalBackendSpawnPriority): Promise<string> {
    const existing = entries.get(key)

    if (existing) {
      existing.lastActiveAt = Date.now()

      if (priority === 'foreground') {
        promote(existing)
      }

      return existing.connection!
    }

    await evict(LIMIT - 1, priority)

    const entry: Entry = { apexProfile: key, lastActiveAt: Date.now(), process: null, spawnPriority: priority }

    entry.connection = start(key, entry).catch(error => {
      if (entries.get(key) === entry) {
        entries.delete(key)
      }

      throw error
    })
    entries.set(key, entry)

    return entry.connection
  }

  // main.ts ipcMain.handle('hermes:connection'): applySpawnPriority, then the claim.
  async function dial(key: string, priority: LocalBackendSpawnPriority = 'background'): Promise<string> {
    let clear = () => undefined as unknown

    if (priority === 'foreground') {
      const existing = entries.get(key)

      if (existing) {
        promote(existing)
      } else {
        pendingForeground.add(key)
        clear = () => pendingForeground.delete(key)
      }
    }

    try {
      return await claims.run(key, () => ensure(key, priority))
    } finally {
      clear()
    }
  }

  // The engines already running hold their slots; all were pinged within the keepalive window.
  for (const [index, [profile]] of running.entries()) {
    const entry: Entry = {
      apexProfile: profile,
      lastActiveAt: Date.now() - pingedAgoMs + index,
      port: 4100,
      process: { pid: 1 },
      spawnPriority: 'background',
      token: 't'
    }

    // Like 0.17.66: the first two were granted background slots, the third the reserved one.
    void coordinator
      .request(profile, { priority: index < LIMIT - 1 ? 'background' : 'foreground' })
      .acquired.then(release => {
        entry.release = release
      })
    entries.set(profile, entry)
  }

  return { asked, coordinator, dial, entries, log, stopped }
}

/** Settle a dial without letting a rejection go unhandled while timers run. */
function settle(dial: Promise<string>) {
  const outcome: { error?: Error; value?: string } = {}

  const done = dial.then(
    value => {
      outcome.value = value
    },
    (error: Error) => {
      outcome.error = error
    }
  )

  return { done, outcome }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000_000 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hc-1093: a user open that joins a background dial makes room at once', () => {
  const RUNNING: Array<[string, Engine]> = [
    ['writer', 'idle'],
    ['editor', 'idle'],
    ['maxer', 'idle']
  ]

  // The 0.17.66 order: the background dial queues for a slot, then the click promotes it.
  test('the click arrives after the background dial queued: the least recently used idle engine goes', async () => {
    const p = pool(RUNNING)
    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(0)
    assert.deepEqual(p.log, ['Profile backend "fourth" waiting for a free local slot (3/3 busy, 1 queued)'])

    const click = settle(p.dial('fourth', 'foreground'))

    await vi.advanceTimersByTimeAsync(100)

    assert.deepEqual(click.outcome, { value: 'engine:fourth' })
    assert.deepEqual(background.outcome, { value: 'engine:fourth' })
    assert.deepEqual(p.stopped, ['writer'])
    assert.deepEqual(p.asked, ['writer:prepare', 'writer:commit'])
    assert.match(p.log[1], /^Evicting profile backend "writer" to make room for another assistant \(committed\)$/)
    assert.equal(p.coordinator.queuedCount, 0)
  })

  // The other order: the click lands while the background owner has not asked for a slot yet.
  test('the click arrives before the background dial asked for a slot: room is made all the same', async () => {
    const p = pool(RUNNING)
    const background = settle(p.dial('fourth'))
    const click = settle(p.dial('fourth', 'foreground'))

    await vi.advanceTimersByTimeAsync(100)

    assert.deepEqual(click.outcome, { value: 'engine:fourth' })
    assert.deepEqual(background.outcome, { value: 'engine:fourth' })
    assert.deepEqual(p.stopped, ['writer'])
  })

  test('every engine mid-turn: both dials fail with the all-busy result at once, nothing is stopped', async () => {
    const p = pool([
      ['writer', 'busy'],
      ['editor', 'busy'],
      ['maxer', 'busy']
    ])

    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(0)
    const click = settle(p.dial('fourth', 'foreground'))
    await vi.advanceTimersByTimeAsync(100)

    assert.deepEqual(parsePoolAllBusy(click.outcome.error), { busy: ['writer', 'editor', 'maxer'], limit: LIMIT })
    assert.equal(background.outcome.error, click.outcome.error, 'one claim, one result')
    assert.deepEqual(p.stopped, [])
    assert.equal(p.coordinator.queuedCount, 0, 'no wait is left behind to start the assistant later')
    assert.equal(p.entries.has('fourth'), false)
    assert.ok(p.log.includes('No room for another assistant: every pooled engine is working (writer, editor, maxer)'))
  })

  test('the third assistant (a free slot, kept for the click) starts without asking anyone', async () => {
    const p = pool(RUNNING.slice(0, 2))
    const background = settle(p.dial('third'))

    await vi.advanceTimersByTimeAsync(0)
    assert.deepEqual(p.log, ['Profile backend "third" waiting for a free local slot (2/3 busy, 1 queued)'])

    settle(p.dial('third', 'foreground'))
    await vi.advanceTimersByTimeAsync(0)

    assert.deepEqual(background.outcome, { value: 'engine:third' })
    assert.deepEqual(p.asked, [])
    assert.deepEqual(p.stopped, [])
  })
})

describe('hc-1093: what stays as it was', () => {
  const RUNNING: Array<[string, Engine]> = [
    ['writer', 'idle'],
    ['editor', 'idle'],
    ['maxer', 'idle']
  ]

  test('several assistants off: the click still waits for a slot as upstream does, and no engine is asked', async () => {
    const p = pool(RUNNING, { multiBot: false })
    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(0)
    const click = settle(p.dial('fourth', 'foreground'))
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS - 1)

    assert.deepEqual(click.outcome, {})
    await vi.advanceTimersByTimeAsync(1)
    await background.done

    assert.match(String(click.outcome.error), /timed out while waiting for a free slot/)
    assert.deepEqual(p.asked, [])
    assert.deepEqual(p.stopped, [])
  })

  test('a background dial alone (reconnect, hydration) never retires an engine pinged within 4 minutes', async () => {
    const p = pool(RUNNING)
    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS)
    await background.done

    assert.match(String(background.outcome.error), /timed out while waiting for a free slot\. \(background\)$/)
    assert.deepEqual(p.asked, [])
    assert.deepEqual(p.stopped, [])
  })

  test('a background dial still evicts an engine nobody pinged for 4 minutes, upstream style, once it retires', async () => {
    const p = pool(RUNNING, { pingedAgoMs: FRESH_MS + 60_000 })
    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(100)

    assert.deepEqual(background.outcome, { value: 'engine:fourth' })
    assert.deepEqual(p.asked, ['writer:prepare', 'writer:commit'])
    assert.deepEqual(p.stopped, ['writer'])
    assert.deepEqual(p.log, ['Evicting idle profile backend "writer" (LRU cap 3): committed'])
  })

  // hc-1102: nobody pings an engine whose turn ended while its background render goes on; the LRU cap
  // used to stop it blind (the render orphaned, and with hc-1102's sweep it would be cut off).
  test('a background dial leaves a stale engine that is still working, and waits like any full pool', async () => {
    const p = pool(
      [
        ['writer', 'busy'],
        ['editor', 'idle'],
        ['maxer', 'idle']
      ],
      { pingedAgoMs: FRESH_MS + 60_000 }
    )

    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(100)

    assert.deepEqual(p.asked, ['writer:prepare'])
    assert.deepEqual(p.stopped, [])
    assert.match(p.log[0], /^Keeping idle profile backend "writer" another 600s: the engine did not retire \(busy\)$/)
    assert.ok(p.entries.has('writer'))

    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS)
    await background.done

    assert.match(String(background.outcome.error), /timed out while waiting for a free slot\. \(background\)$/)
    assert.deepEqual(p.stopped, [])
  })

  // Already right before hc-1093 (hc-1080), pinned: the click owns the dial and a background dial joins it.
  test('the click first: room is made before the slot is asked for, and the joining dial shares the engine', async () => {
    const p = pool(RUNNING)
    const click = settle(p.dial('fourth', 'foreground'))
    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(100)

    assert.deepEqual(click.outcome, { value: 'engine:fourth' })
    assert.deepEqual(background.outcome, { value: 'engine:fourth' })
    assert.deepEqual(p.stopped, ['writer'])
    assert.equal(
      p.log.some(line => line.includes('waiting for a free local slot')),
      false,
      'the slot was free by then'
    )
  })

  test('the click first with every engine mid-turn: the joining dial gets the same all-busy result', async () => {
    const p = pool([
      ['writer', 'busy'],
      ['editor', 'busy'],
      ['maxer', 'busy']
    ])

    const click = settle(p.dial('fourth', 'foreground'))
    const background = settle(p.dial('fourth'))

    await vi.advanceTimersByTimeAsync(0)

    assert.deepEqual(parsePoolAllBusy(click.outcome.error)?.busy, ['writer', 'editor', 'maxer'])
    assert.equal(background.outcome.error, click.outcome.error)
  })
})
