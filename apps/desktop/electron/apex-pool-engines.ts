/**
 * apex-pool-engines.ts — the pooled profile engines and the APEX relay key
 * (hc-1080).
 *
 * Every assistant other than the one the primary engine serves runs in a
 * pooled `hermes --profile <name> serve` child (main.ts backendPool: at most 3,
 * reaped after 10 idle minutes). Two things here:
 *
 * 1. Restart on a new relay key. A running engine builds its LLM client from
 *    config.yaml once per session, so rewriting the key on disk is not enough —
 *    the same reason main reloads the primary engine after a rotation
 *    (reloadBackendForRelayKey). Each pooled child is stamped with the key it
 *    was spawned under; after any key sync, the children of managed profiles
 *    spawned under another key are stopped, and the renderer's reconnect
 *    respawns them on the new one. A child already on the current key (say,
 *    one respawned between two syncs) is left alone.
 *
 * 2. Idle reaping asks the engine first. The reaper only sees `lastActiveAt`,
 *    which the renderer bumps every minute while it holds a socket to that
 *    engine. With the window closed (macOS keeps the app running) or the
 *    renderer reloading, nobody bumps it, and a turn still running there — a
 *    multi-clip video render takes well over ten minutes — would be killed.
 *    The engine has a cooperative retirement fence for exactly this
 *    (hermes_cli/backend_retirement.py): `prepare` freezes admission and
 *    answers idle or not, `commit` closes admission for good. Only a committed
 *    retirement is stopped; a busy or undecidable engine gets another idle
 *    window.
 */

import { poolAllBusyMessage } from '../shared/apex-pool-busy'

import { maskRelayKey } from './apex-relay-key-anchors'

/** The pool-entry fields this module reads and writes. */
export interface PoolEngineEntry {
  /** Profile the child serves (the pool key can be a composite registry scope). */
  apexProfile?: string
  /** maskRelayKey() of the relay key the child was spawned under; '' when signed out. */
  apexRelayKey?: string
  /** True while an idle-retirement probe is in flight. */
  apexRetiring?: boolean
  /** Consecutive retirement probes that got no answer at all. */
  apexRetireProbeFailures?: number
  lastActiveAt?: null | number
  port?: null | number
  process?: unknown
  token?: null | string
}

/** Record which profile and key a freshly spawned child holds. */
export function stampPoolEngine(entry: PoolEngineEntry, profile: string, relayKey: string | undefined): void {
  entry.apexProfile = profile
  entry.apexRelayKey = relayKey ? maskRelayKey(relayKey) : ''
}

/**
 * Pool keys whose local child serves one of `profiles` (the managed homes) but
 * was spawned under a relay key other than `relayKey`. Remote descriptors
 * (no child) and unstamped entries are never picked.
 */
export function poolKeysOnStaleRelayKey(
  entries: Iterable<[string, PoolEngineEntry]>,
  profiles: Iterable<string>,
  relayKey: string | undefined
): string[] {
  if (!relayKey) {
    return []
  }

  const managed = new Set(profiles)
  const current = maskRelayKey(relayKey)

  return [...entries]
    .filter(([, entry]) => Boolean(entry.process) && entry.apexProfile !== undefined && managed.has(entry.apexProfile))
    .filter(([, entry]) => entry.apexRelayKey !== current)
    .map(([key]) => key)
}

export interface RetirementVerdict {
  reason: string
  retire: boolean
}

/** POST a JSON body to the child's dashboard API; rejects with `statusCode` / `code` like main's fetchJson. */
export type PoolEnginePost = (path: string, body: Record<string, unknown>) => Promise<any>

const RETIREMENT_PATH = '/api/health/retirement'
// Status codes from an engine that predates the fence (older bundled runtimes,
// an adopted external one): there is nothing to ask, reap as before.
const NO_FENCE_STATUS = new Set([404, 405])
// Nothing listening: the child is gone or never bound, no turn to protect.
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'])
/** Unanswered probes (timeouts, 5xx) tolerated before an idle child is reaped anyway. */
export const MAX_RETIRE_PROBE_FAILURES = 3

/**
 * Ask a pooled engine to retire. `retire: true` only for a committed fence, an
 * engine without the fence, or one that is not listening. A busy engine (a turn
 * in flight, a cron run, a prompt waiting on the user), an indeterminate one, or
 * a commit that lost its permit is kept. `stillIdle` is re-read between prepare
 * and commit: a renderer that came back to this engine meanwhile cancels the
 * permit, since a commit closes admission for good.
 */
export async function askPoolEngineToRetire(
  post: PoolEnginePost,
  stillIdle: () => boolean = () => true
): Promise<RetirementVerdict> {
  let prepared: any

  try {
    prepared = await post(RETIREMENT_PATH, { action: 'prepare' })
  } catch (error: any) {
    if (NO_FENCE_STATUS.has(Number(error?.statusCode))) {
      return { retire: true, reason: 'no-fence' }
    }

    if (UNREACHABLE_CODES.has(String(error?.code || ''))) {
      return { retire: true, reason: 'unreachable' }
    }

    return { retire: false, reason: `probe-failed: ${error?.statusCode || error?.code || error?.message || error}` }
  }

  if (prepared?.ok !== true || typeof prepared.token !== 'string' || !prepared.token) {
    return { retire: false, reason: prepared?.idle === false ? 'busy' : 'indeterminate' }
  }

  if (!stillIdle()) {
    await post(RETIREMENT_PATH, { action: 'cancel', token: prepared.token }).catch(() => undefined)

    return { retire: false, reason: 'touched' }
  }

  try {
    const committed = await post(RETIREMENT_PATH, { action: 'commit', token: prepared.token })

    return committed?.ok === true ? { retire: true, reason: 'committed' } : { retire: false, reason: 'commit-refused' }
  } catch (error: any) {
    return { retire: false, reason: `commit-failed: ${error?.statusCode || error?.code || error?.message || error}` }
  }
}

export interface IdleReapDeps {
  entry: PoolEngineEntry
  label: string
  idleSeconds: number
  post: PoolEnginePost
  /** False once the entry left the pool (stopped, evicted, respawned) during the probe. */
  stillPooled: () => boolean
  stop: () => Promise<void> | void
  log: (line: string) => void
  now?: () => number
}

/**
 * One idle-reaper decision for one pool entry already past the idle window.
 * Remote descriptors and children that never finished starting are stopped as
 * before; a live local engine is asked first (askPoolEngineToRetire). A kept
 * engine's `lastActiveAt` moves to now, so it is asked again one idle window
 * later rather than every reaper tick. Probe failures are capped so a wedged
 * engine is not kept forever.
 */
export async function reapIdlePoolEngine(deps: IdleReapDeps): Promise<'kept' | 'skipped' | 'stopped'> {
  const { entry, label, log } = deps
  const now = deps.now ?? Date.now
  const reaping = `Reaping idle profile backend "${label}" (idle > ${deps.idleSeconds}s)`

  if (!entry.process || !entry.port || !entry.token) {
    log(reaping)
    await deps.stop()

    return 'stopped'
  }

  if (entry.apexRetiring) {
    return 'skipped'
  }

  entry.apexRetiring = true
  const touchedAt = entry.lastActiveAt
  const stillIdle = () => deps.stillPooled() && entry.lastActiveAt === touchedAt
  let verdict: RetirementVerdict

  try {
    verdict = await askPoolEngineToRetire(deps.post, stillIdle)
  } finally {
    entry.apexRetiring = false
  }

  // Gone from the pool (stopped, or respawned under the same key): whoever
  // removed it owns the stop. Touched meanwhile: in use again, unless the engine
  // already committed, which closed its admission for good.
  if (!deps.stillPooled() || (verdict.reason !== 'committed' && entry.lastActiveAt !== touchedAt)) {
    return 'skipped'
  }

  const failures = verdict.reason.startsWith('probe-failed') ? (entry.apexRetireProbeFailures || 0) + 1 : 0
  entry.apexRetireProbeFailures = failures

  if (verdict.retire || failures >= MAX_RETIRE_PROBE_FAILURES) {
    log(`${reaping}: ${verdict.retire ? verdict.reason : `${verdict.reason}, ${failures} unanswered probes`}`)
    await deps.stop()

    return 'stopped'
  }

  entry.lastActiveAt = now()
  log(
    `Keeping idle profile backend "${label}" another ${deps.idleSeconds}s: the engine did not retire (${verdict.reason})`
  )

  return 'kept'
}

export interface MakeRoomResult {
  /** True once at most `keep` local engines remain. */
  room: boolean
  /** Pool keys retired and stopped, least recently used first. */
  evicted: string[]
  /** Profiles that would not retire (mid-turn, starting, undecidable), least recently used first. */
  busy: string[]
}

export interface MakeRoomDeps {
  entries: Iterable<[string, PoolEngineEntry]>
  /** How many local engines may stay (the pool limit minus the one about to start). */
  keep: number
  /** The retirement endpoint of one entry's engine. */
  post: (entry: PoolEngineEntry) => PoolEnginePost
  /** False once the entry left the pool or was replaced under the same key. */
  stillPooled: (key: string, entry: PoolEngineEntry) => boolean
  stop: (key: string) => Promise<void>
  log: (line: string) => void
}

/**
 * hc-1080, several assistants on: make room for one more local engine when a
 * user opens an assistant. Upstream eviction only takes engines nobody pinged
 * for 4 minutes, so a fourth assistant opened within that window waited 30 s
 * for a slot and failed. Here every local engine is a candidate, least recently
 * used first, and each is asked to retire (askPoolEngineToRetire): an idle one
 * goes (its assistant cold-starts next time), one with a turn in flight, still
 * starting, or that cannot say, stays. `room: false` means all of them are working.
 */
export async function makeRoomInPool(deps: MakeRoomDeps): Promise<MakeRoomResult> {
  const local = [...deps.entries]
    .filter(([, entry]) => Boolean(entry.process))
    .sort((a, b) => (a[1].lastActiveAt || 0) - (b[1].lastActiveAt || 0))

  const evicted: string[] = []
  const busy: string[] = []
  let excess = local.length - Math.max(0, deps.keep)

  for (const [key, entry] of local) {
    if (excess <= 0) {
      break
    }

    const name = entry.apexProfile ?? key

    if (!entry.port || !entry.token || entry.apexRetiring) {
      busy.push(name)

      continue
    }

    entry.apexRetiring = true
    const touchedAt = entry.lastActiveAt
    let verdict: RetirementVerdict

    try {
      verdict = await askPoolEngineToRetire(
        deps.post(entry),
        () => deps.stillPooled(key, entry) && entry.lastActiveAt === touchedAt
      )
    } finally {
      entry.apexRetiring = false
    }

    // Gone meanwhile (stopped or reaped elsewhere): its slot is free either way.
    if (!deps.stillPooled(key, entry)) {
      excess -= 1

      continue
    }

    if (!verdict.retire) {
      busy.push(name)

      continue
    }

    deps.log(`Evicting profile backend "${key}" to make room for another assistant (${verdict.reason})`)
    await deps.stop(key)
    evicted.push(key)
    excess -= 1
  }

  return { room: excess <= 0, evicted, busy }
}

/** The error an open fails with when makeRoomInPool found every engine working (shared/apex-pool-busy.ts). */
export function poolAllBusyError(result: MakeRoomResult, limit: number): Error {
  return new Error(poolAllBusyMessage({ busy: result.busy, limit }))
}
