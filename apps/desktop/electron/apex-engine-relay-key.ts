/**
 * apex-engine-relay-key.ts — running engines and the APEX relay key (hc-1106).
 *
 * Signing in again on the same device rotates the relay key: the server marks
 * the old one `rotated` and the relay answers it with 401 「当前 APEX 凭据无效或
 * 已失效」. Writing the new key into every config.yaml (hc-595, hc-1080) is not
 * enough, because a running process keeps the key it was spawned with in two
 * places:
 *
 *   - the LLM client of each session, built from config.yaml once per session
 *     (`POST /api/model/set` "applies to new sessions only", and the single-thread
 *     main line is one long session);
 *   - `TOOLS_GATEWAY_KEY` in its env, which the platform tools read before
 *     config.yaml (apex-platform-tools.ts, hc-604).
 *
 * hc-1080 restarted the pooled engines on a new key. The primary engine (APEX
 * itself with one assistant, or the assistant pinned last time with several)
 * and the messaging gateway kept the old key until the app quit, and the 401
 * self-heal could not see it: it probes the key on disk, which is the new one.
 *
 * Every process that holds the key is described here the same way
 * (RelayKeyHolder): the fingerprint of the key its spawn env carried (never the
 * key), how to ask whether it may stop without cutting off a turn, and how to
 * restart it. After any key sync, and when the relay accepts the stored key on
 * a 401, the holders on another key restart once idle. A busy one is asked
 * again every 30 s until it is idle, its successor runs on the new key, or the
 * user signed out.
 *
 * Idle means: an engine's retirement fence commits (askPoolEngineToRetire, the
 * hc-1080 reaper's check); the messaging gateway has no fence, so its
 * gateway_state.json must report `active_agents: 0`. An IM message that
 * arrives between that read and the stop is cut off; the window is the few
 * milliseconds of a file read.
 *
 * A process spawned signed out carries no key in its env; its platform tools
 * read config.yaml, which is always current. The messaging gateway then holds
 * nothing that can go stale: it builds each turn's LLM client from config.yaml
 * and rebuilds a cached agent when the key changes (gateway/run_agent_cache.py).
 * The primary engine does not: the sessions it builds after the first sign-in
 * keep that key. So the first key it sees is adopted as its stamp (no restart;
 * nothing it built holds an older relay key), and the next change restarts it.
 * Pooled engines keep hc-1080's rule: one spawned signed out restarts after
 * sign-in.
 *
 * Electron-free, like its siblings: unit-tested with `vitest --project electron`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { reconcileManagedRelayKey } from './apex-managed'
import {
  askPoolEngineToRetire,
  type PoolEngineEntry,
  type PoolEnginePost,
  type RetirementVerdict
} from './apex-pool-engines'
import { maskRelayKey } from './apex-relay-key-anchors'

/** One running process that holds the relay key it was spawned with. */
export interface RelayKeyHolder {
  /** For the log line, e.g. `primary backend "apex-bot-2"`. */
  label: string
  /** maskRelayKey() of the key it holds; '' when it was spawned signed out and holds none yet. */
  stamp: string
  /** Take `stamp` as the key it holds from now on, instead of restarting ('' stamps only). */
  adopt?: (stamp: string) => void
  /** May it stop now without cutting off a turn? */
  retire: () => Promise<RetirementVerdict>
  /** False once it was stopped or replaced while it was asked; its successor reads the fresh key. */
  current: () => boolean
  /** Stop it (or re-home it); the next spawn reads the fresh key. */
  restart: () => Promise<unknown>
}

const processStamps = new WeakMap<object, string>()

/** Record the key a freshly spawned primary engine or messaging gateway carries ('' signed out). */
export function stampKeyHolderProcess(child: null | object | undefined, relayKey: null | string | undefined): void {
  if (child) {
    processStamps.set(child, relayKey ? maskRelayKey(relayKey) : '')
  }
}

/** True when `child` was stamped with `relayKey` (or adopted it): its env and sessions hold that key. */
export function holdsRelayKey(child: null | object | undefined, relayKey: null | string | undefined): boolean {
  return Boolean(child && relayKey) && processStamps.get(child as object) === maskRelayKey(String(relayKey))
}

type LiveChild = () => null | object | undefined

/** The live process from `live`, with its stamp, while it stays the live one. Unstamped: none. */
function stampedProcess(live: LiveChild) {
  const child = live()
  const stamp = child ? processStamps.get(child) : undefined

  if (!child || stamp === undefined) {
    return null
  }

  return { stamp, current: () => live() === child, adopt: (next: string) => processStamps.set(child, next) }
}

/** The primary engine, when it was stamped at spawn. `live` returns the primary's process. */
export function primaryKeyHolder(
  live: LiveChild,
  profile: string,
  deps: { post: PoolEnginePost; restart: () => Promise<unknown> }
): RelayKeyHolder[] {
  const held = stampedProcess(live)

  if (!held) {
    return []
  }

  return [
    {
      label: `primary backend "${profile}"`,
      stamp: held.stamp,
      adopt: held.adopt,
      retire: () => askPoolEngineToRetire(deps.post, held.current),
      current: held.current,
      restart: deps.restart
    }
  ]
}

/**
 * Every local pooled engine (hc-1080 stamps them at spawn). Not only the
 * managed profiles: a BYOK profile's engine still carries the platform-tool key.
 * An entry already being asked by the idle reaper or makeRoomInPool waits.
 */
export function poolKeyHolders(
  entries: Iterable<[string, PoolEngineEntry]>,
  deps: {
    post: (entry: PoolEngineEntry) => PoolEnginePost
    stillPooled: (key: string, entry: PoolEngineEntry) => boolean
    stop: (key: string) => Promise<unknown>
  }
): RelayKeyHolder[] {
  return [...entries]
    .filter(([, entry]) => Boolean(entry.process) && entry.apexRelayKey !== undefined)
    .map(([key, entry]) => ({
      label: `profile backend "${key}"`,
      stamp: entry.apexRelayKey || '',
      retire: async () => {
        if (!entry.port || !entry.token || entry.apexRetiring) {
          return { retire: false, reason: entry.apexRetiring ? 'being asked' : 'starting' }
        }

        entry.apexRetiring = true
        const touchedAt = entry.lastActiveAt

        try {
          return await askPoolEngineToRetire(
            deps.post(entry),
            () => deps.stillPooled(key, entry) && entry.lastActiveAt === touchedAt
          )
        } finally {
          entry.apexRetiring = false
        }
      },
      current: () => deps.stillPooled(key, entry),
      restart: () => deps.stop(key)
    }))
}

/** `<home>/gateway_state.json` of the profile a messaging gateway serves. */
export function gatewayStatePath(root: string, profile: null | string | undefined): string {
  const name = String(profile || '').trim()
  const home = !name || name === 'default' ? root : path.join(root, 'profiles', name)

  return path.join(home, 'gateway_state.json')
}

/** Idle iff the gateway reports no agent at work (gateway/status.py `active_agents`). */
export function gatewayIdleVerdict(read: () => string): RetirementVerdict {
  let state: any

  try {
    state = JSON.parse(read())
  } catch (error: any) {
    // Not written yet: a gateway still starting has served nothing.
    return error?.code === 'ENOENT'
      ? { retire: true, reason: 'no-state' }
      : { retire: false, reason: 'unreadable-state' }
  }

  const active = state?.active_agents

  if (active === 0) {
    return { retire: true, reason: 'idle' }
  }

  return { retire: false, reason: Number.isInteger(active) && active > 0 ? `busy (${active} active)` : 'indeterminate' }
}

/** The messaging gateway, when it was spawned holding a key. `live` returns its process while it runs. */
export function gatewayKeyHolder(
  live: LiveChild,
  statePath: string,
  deps: { restart: () => Promise<unknown>; read?: (file: string) => string }
): RelayKeyHolder[] {
  const held = stampedProcess(live)
  const read = deps.read ?? ((file: string) => fs.readFileSync(file, 'utf8'))

  // Spawned signed out: nothing in it can go stale (see the header).
  if (!held?.stamp) {
    return []
  }

  return [
    {
      label: 'messaging gateway',
      stamp: held.stamp,
      retire: async () => gatewayIdleVerdict(() => read(statePath)),
      current: held.current,
      restart: deps.restart
    }
  ]
}

export interface StaleKeyRestartResult {
  /** Holders restarted onto the stored key. */
  restarted: string[]
  /** Holders still on another key because they were busy; asked again later. */
  waiting: string[]
}

export const STALE_KEY_RETRY_MS = 30_000
/** One hour of 30 s retries; the next key sync or 401 starts over. */
export const STALE_KEY_MAX_RETRIES = 120

export interface StaleRelayKeyRestartDeps {
  holders: () => RelayKeyHolder[]
  relayKey: () => null | string | undefined
  log: (line: string) => void
  retryMs?: number
  maxRetries?: number
  setTimer?: (run: () => void, ms: number) => unknown
}

/**
 * Restarts the holders that run on another key than the stored one. Runs are
 * serialized, so a run never overlaps another one's fence or restart, and each
 * evaluates the holders afresh.
 */
export class StaleRelayKeyRestarts {
  private tail: Promise<unknown> = Promise.resolve()
  private retryPending = false
  private retries = 0
  private waitingLogged = new Set<string>()

  constructor(private deps: StaleRelayKeyRestartDeps) {}

  run(reason: string, retry = false): Promise<StaleKeyRestartResult> {
    const next = this.tail.then(() => this.once(reason, retry))
    this.tail = next.catch(() => undefined)

    return next
  }

  private async once(reason: string, retry: boolean): Promise<StaleKeyRestartResult> {
    const result: StaleKeyRestartResult = { restarted: [], waiting: [] }
    const key = this.deps.relayKey()

    if (!retry) {
      this.retries = 0
    }

    // Signed out: there is no key to move to.
    if (!key) {
      return result
    }

    const current = maskRelayKey(key)

    for (const holder of this.deps.holders().filter(candidate => candidate.stamp !== current)) {
      if (!holder.stamp && holder.adopt) {
        holder.adopt(current)
        this.deps.log(
          `[apexnodes] ${holder.label} was started signed out; its new sessions take the relay key from config.yaml (${reason})`
        )

        continue
      }

      const verdict = await holder.retire()

      if (!holder.current()) {
        continue
      }

      if (!verdict.retire) {
        result.waiting.push(holder.label)

        // Once per wait, not on every retry or overlapping run.
        if (!this.waitingLogged.has(holder.label)) {
          this.deps.log(
            `[apexnodes] ${holder.label} still holds the previous relay key; restarting it once idle (${verdict.reason}; ${reason})`
          )
        }

        continue
      }

      this.deps.log(`[apexnodes] restarting ${holder.label} for the refreshed relay key (${reason}; ${verdict.reason})`)

      try {
        await holder.restart()
        result.restarted.push(holder.label)
      } catch (error: any) {
        // Not retried: a failed respawn is the boot path's to report; the other holders still go.
        this.deps.log(`[apexnodes] restarting ${holder.label} failed: ${error?.message || error}`)
      }
    }

    this.waitingLogged = new Set(result.waiting)
    this.scheduleRetry(result.waiting, reason)

    return result
  }

  private scheduleRetry(waiting: string[], reason: string) {
    if (waiting.length === 0 || this.retryPending) {
      return
    }

    if (this.retries >= (this.deps.maxRetries ?? STALE_KEY_MAX_RETRIES)) {
      this.deps.log(
        `[apexnodes] stopped waiting for ${waiting.join(', ')} to go idle; the next key check retries (${reason})`
      )

      return
    }

    this.retries += 1
    this.retryPending = true
    const setTimer = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms).unref?.())

    setTimer(() => {
      this.retryPending = false
      void this.run(reason, true)
    }, this.deps.retryMs ?? STALE_KEY_RETRY_MS)
  }
}

/**
 * The 401 self-heal (reconcileManagedRelayKey) proves the STORED key with a
 * relay probe. When the relay accepts it and nothing was re-provisioned, a 401
 * came from a running process still on an older key: restart the holders on
 * another key (once idle) and report which.
 *
 * `completeRuntime` tells the caller to (re)complete the managed runtime on the
 * target engine (finishManagedModelRuntime): when it is still pending, as
 * before, or when an engine restarted here, so the renderer gets an assignment
 * back and retries the failed turn on the restarted engine.
 */
export async function reconcileRelayKeyAndEngines(
  deps: Parameters<typeof reconcileManagedRelayKey>[0],
  restartStale: (reason: string) => Promise<StaleKeyRestartResult>,
  runtimePending: () => boolean = () => false
) {
  const outcome = await reconcileManagedRelayKey(deps)
  const isCurrent = typeof deps.isCurrent === 'function' ? deps.isCurrent : () => true

  if (!outcome.ok || outcome.probeStatus !== 'ok' || outcome.relayUnauthorized || !isCurrent()) {
    return {
      ...outcome,
      enginesRestarted: [] as string[],
      completeRuntime: outcome.probeStatus === 'ok' && runtimePending()
    }
  }

  const { restarted } = await restartStale('relay-401')
  const enginesRestarted = isCurrent() ? restarted : []

  return { ...outcome, enginesRestarted, completeRuntime: enginesRestarted.length > 0 || runtimePending() }
}
