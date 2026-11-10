/**
 * apex-platform-skills-refresh.ts — the platform skills keep up while APEX stays open (hc-1205).
 *
 * The platform SKILL sync (apex-platform-skills-sync.ts) ran at boot and after a sign-in and
 * nowhere else, so an install left open kept the skills it launched with. On 2026-11-08 the server
 * shipped short-video-review 1.1.1 at 21:04Z; a Mac that stayed open overnight still had 1.0.0 the
 * next morning, in the root and in both assistants, until a restart installed it
 * (`installed 64 skill(s) … (boot)`).
 *
 * While the app runs the check repeats, at most once per CHECK_EVERY_MS of wall-clock time (the
 * hours a Mac sleeps count): when a window comes to the front (`focus`), and from a timer for the
 * install nobody looks at, an assistant that only answers on IM (`interval`). A check is the boot
 * request with `known_hash`, so an unchanged manifest costs that one request and writes nothing.
 * Signed out, or with the switch off, nothing is asked.
 *
 * A new manifest installs the way boot installs it, the root from the manifest and then a stamped
 * copy in every profile on the managed relay, but never under a turn. A turn reads skills as it
 * goes (the index in its prompt, then SKILL.md and its references through skill_view), and a swap
 * in the middle could hand it two versions of one skill. So the fetched manifest waits in memory
 * until nothing runs (whatRuns), asked again every BUSY_RETRY_MS:
 *   - no window reports a running chat (store/active-work.ts, what the quit confirmation reads);
 *   - every local engine (the primary and each pooled one) answers `GET /api/health/idle` with
 *     idle: no turn, cron job, background command or prompt waiting on the user. An engine that
 *     does not answer in time counts as busy;
 *   - the messaging gateway, while it runs, has no agent at work in gateway_state.json. IM turns
 *     run there, outside the engines; the hc-1106 relay-key restart reads it the same way.
 *
 * Boot and sign-in still install at once, as before. Runs take turns (a refresh, a check, a retry),
 * so two fetches never install out of order, and a boot or sign-in refresh drops a manifest that
 * is still waiting: it fetches the current one itself. Once the quit teardown starts, nothing more
 * installs.
 *
 * The client config and the platform plugins keep their boot and sign-in checks only: a newer
 * client config counts from the next launch by contract (apex-client-config-sync.ts), and a
 * platform plugin is code that loads at the next engine start (apex-platform-plugins.ts).
 *
 * Electron-free, like its siblings: main passes the transports, the paths and the activity probes.
 */

import fs from 'node:fs'
import path from 'node:path'

import { gatewayIdleVerdict } from './apex-engine-relay-key'
import { isPlatformSkillsEnabled, normalizeStoredManifest } from './apex-platform-skills'
import {
  type FetchedPlatformSkills,
  fetchNewPlatformSkills,
  installPlatformSkills,
  type StoredPlatformSkills,
  syncPlatformSkills
} from './apex-platform-skills-sync'
import type { LocalEngine } from './apex-quit-confirm'

/** A running install asks the server at most this often (wall clock). */
export const CHECK_EVERY_MS = 60 * 60_000
/** How often the timer looks whether a check is due; looking costs no request. */
export const TICK_MS = 5 * 60_000
/** While a new manifest waits for the turns to end, how often it asks again. */
export const BUSY_RETRY_MS = 30_000
/** How long one engine gets to answer the idle probe before it counts as busy. */
export const ENGINE_IDLE_DEADLINE_MS = 3_000

/** What whatRuns asks; main supplies each from what it already tracks. */
export interface RunningWork {
  /** Chats the open windows report running, merged across windows. */
  windowTurns: () => number
  /** The local engines a turn could run in (apex-quit-confirm.ts localEnginesOf). */
  engines: () => Promise<LocalEngine[]>
  /** `GET /api/health/idle` on one engine. */
  probe: (engine: LocalEngine) => Promise<unknown>
  /** gateway_state.json of the running messaging gateway; null while none runs. */
  gatewayState: () => null | string
  readFile?: (file: string) => string
  probeDeadlineMs?: number
}

function answerWithin(answer: () => Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms)

    Promise.resolve()
      .then(answer)
      .then(resolve, () => resolve(undefined))
      .finally(() => clearTimeout(timer))
  })
}

/** Only an idle snapshot proves idle; a busy, indeterminate or missing answer does not. */
export function engineIsIdle(snapshot: unknown): boolean {
  const { idle, ok } = (snapshot ?? {}) as { idle?: unknown; ok?: unknown }

  return ok === true && idle === true
}

function snapshotReason(snapshot: unknown): string {
  const { reason } = (snapshot ?? {}) as { reason?: unknown }

  return typeof reason === 'string' && reason ? reason : 'no answer'
}

/** What still runs, said for the log, or null when nothing does. Cheapest question first. */
export async function whatRuns({
  engines,
  gatewayState,
  probe,
  probeDeadlineMs = ENGINE_IDLE_DEADLINE_MS,
  readFile = file => fs.readFileSync(file, 'utf8'),
  windowTurns
}: RunningWork): Promise<null | string> {
  const chats = windowTurns()

  if (chats > 0) {
    return `${chats} chat(s) running in a window`
  }

  const local = await engines()
  const answers = await Promise.all(local.map(engine => answerWithin(() => probe(engine), probeDeadlineMs)))
  const busy = answers.filter(answer => !engineIsIdle(answer))

  if (busy.length > 0) {
    return `${busy.length} of ${local.length} engine(s) not idle (${busy.map(snapshotReason).join(', ')})`
  }

  const statePath = gatewayState()
  const gateway = statePath ? gatewayIdleVerdict(() => readFile(statePath)) : null

  return gateway && !gateway.retire ? `messaging gateway ${gateway.reason}` : null
}

export interface PlatformSkillsRefreshDeps extends RunningWork {
  apiBase: () => string
  env: Record<string, string | undefined>
  /** The JWT transport hc-1073 hears 401s on (main's apexAuthGetJson). */
  fetchJson: (url: string, options?: object) => Promise<unknown>
  /** The root plus every profile on the managed relay (hc-1080 apexConfigHomes), read at install. */
  homes: () => unknown
  log: (line: string) => void
  /** Registers the listener for a window coming to the front (app 'browser-window-focus'). */
  onFocus: (listener: () => void) => void
  /** Aborted once the quit teardown starts. */
  signal: AbortSignal
  skillsRoot: string
  /** userData/apex-platform-skills.json: the manifest installed. */
  statePath: string
  /** The stored login JWT. */
  token: () => unknown
  writeFileAtomic: (file: string, text: string) => void
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  checkEveryMs?: number
  tickMs?: number
  busyRetryMs?: number
}

interface Waiting {
  /** The installed hash it was fetched against; an install since then replaces it. */
  base: string
  fetched: FetchedPlatformSkills
  /** The wait was logged (once per manifest). */
  logged: boolean
  reason: string
}

function startTimer(run: () => void, ms: number) {
  const timer = setTimeout(run, ms)
  timer.unref?.()

  return timer
}

const short = (hash: string) => hash.slice(0, 12)

const messageOf = (error: any) => (error && error.message ? error.message : error)

export function createPlatformSkillsRefresh(deps: PlatformSkillsRefreshDeps) {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? startTimer
  const clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const checkEveryMs = deps.checkEveryMs ?? CHECK_EVERY_MS
  let tail: Promise<void> = Promise.resolve()
  let lastCheckAt = now()
  let waiting: null | Waiting = null
  let queued = false
  let timer: unknown = null
  let timerMs = 0

  const stopped = () => deps.signal.aborted

  function readStored() {
    try {
      return normalizeStoredManifest(JSON.parse(fs.readFileSync(deps.statePath, 'utf8')))
    } catch {
      return normalizeStoredManifest(null)
    }
  }

  function writeStored(next: StoredPlatformSkills) {
    fs.mkdirSync(path.dirname(deps.statePath), { recursive: true })
    deps.writeFileAtomic(deps.statePath, JSON.stringify(next, null, 2))
  }

  /** One run at a time. Never rejects: callers `void` it. */
  function enqueue(job: () => Promise<void>): Promise<void> {
    tail = tail.then(job).catch(error => deps.log(`[platform-skills] refresh failed (ignored): ${messageOf(error)}`))

    return tail
  }

  async function refreshNow(reason: string) {
    waiting = null
    lastCheckAt = now()

    try {
      const result = await syncPlatformSkills({
        apiBase: deps.apiBase(),
        env: deps.env,
        fetchJson: deps.fetchJson,
        homes: deps.homes(),
        log: deps.log,
        reason,
        skillsRoot: deps.skillsRoot,
        stored: readStored(),
        token: deps.token
      })

      if (result.newStored) {
        writeStored(result.newStored)
      }
    } catch (error) {
      deps.log(`[platform-skills] refresh failed (ignored): ${messageOf(error)}`)
    }
  }

  async function installWhenIdle() {
    const held = waiting

    if (!held || stopped()) {
      return
    }

    if (readStored().manifestHash !== held.base) {
      waiting = null
      deps.log(
        `[platform-skills] manifest ${short(held.fetched.manifestHash)} dropped: another install landed first (${held.reason})`
      )

      return
    }

    let busy: null | string

    try {
      busy = await whatRuns(deps)
    } catch (error) {
      busy = `activity unknown (${messageOf(error)})`
    }

    if (waiting !== held || stopped()) {
      return
    }

    if (busy) {
      if (!held.logged) {
        held.logged = true
        deps.log(
          `[platform-skills] manifest ${short(held.fetched.manifestHash)} waits until no turn runs: ${busy} (${held.reason})`
        )
      }

      return
    }

    waiting = null

    try {
      writeStored(
        installPlatformSkills({
          env: deps.env,
          fetched: held.fetched,
          homes: deps.homes(),
          log: deps.log,
          now,
          reason: held.reason,
          skillsRoot: deps.skillsRoot
        })
      )
    } catch (error) {
      deps.log(`[platform-skills] refresh failed (ignored): ${messageOf(error)}`)
    }
  }

  async function checkNow(reason: string) {
    try {
      if (stopped() || !isPlatformSkillsEnabled(deps.env) || !String(deps.token() || '').trim()) {
        return // the switch-off revert and the sign-in are boot's and sign-in's to do
      }

      lastCheckAt = now()
      const stored = readStored()

      const fetched = await fetchNewPlatformSkills({
        apiBase: deps.apiBase(),
        env: deps.env,
        fetchJson: deps.fetchJson,
        log: deps.log,
        reason,
        stored,
        token: deps.token
      })

      if (!fetched || stopped()) {
        return
      }

      waiting = { base: stored.manifestHash, fetched, logged: false, reason }
    } catch (error) {
      deps.log(`[platform-skills] check failed (ignored): ${messageOf(error)} (${reason})`)

      return
    }

    await installWhenIdle()
  }

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  /** Tick at the pace the state asks for: BUSY_RETRY_MS while a manifest waits, else TICK_MS. */
  function arm() {
    const ms = waiting ? (deps.busyRetryMs ?? BUSY_RETRY_MS) : (deps.tickMs ?? TICK_MS)

    if (stopped() || (timer !== null && timerMs === ms)) {
      return
    }

    cancelTimer()
    timerMs = ms
    timer = setTimer(() => {
      timer = null
      nudge('interval')
    }, ms)
  }

  /** A tick or a focus: a waiting manifest asks again; otherwise check, when one is due. */
  function nudge(reason: string) {
    if (queued || stopped()) {
      return
    }

    queued = true
    void enqueue(async () => {
      queued = false
      const elapsed = now() - lastCheckAt

      if (waiting) {
        await installWhenIdle()
      } else if (elapsed >= checkEveryMs || elapsed < 0) {
        await checkNow(reason)
      }
    }).finally(arm)
  }

  deps.onFocus(() => nudge('focus'))
  deps.signal.addEventListener('abort', () => {
    cancelTimer()
    waiting = null
  })
  arm()

  return {
    /** Boot and sign-in: fetch and install at once, as before. Never rejects. */
    refresh(reason: string): Promise<void> {
      waiting = null

      return enqueue(() => refreshNow(reason)).finally(arm)
    },

    /** What a profile copy needs, read now: the M2 entry (registerProfileSkillsSync). */
    fillArgs: () => ({
      env: deps.env,
      homes: deps.homes(),
      log: deps.log,
      manifestHash: readStored().manifestHash,
      skillsRoot: deps.skillsRoot
    }),

    /** Resolves once every run queued so far has finished. */
    settled: () => tail
  }
}
