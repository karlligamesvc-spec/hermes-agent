/**
 * apex-config-arrival.ts
 *
 * The product-defaults guard in main.ts (guardConfigYamlProductBlocks) can only
 * heal a config.yaml that EXISTS — it never invents one — and the live watcher
 * it arms likewise needs a file to watch. On a brand-new HERMES_HOME neither
 * has anything to work with: the file shows up SECONDS LATER, written by
 * whoever gets there first (the runtime's own first save, install.sh copying
 * cli-config.yaml.example, a bundle-mode install), and whatever that writer put
 * in it is then the user's config forever. That is the exact shape of the
 * fresh-install bug this module exists for: with no `display.language` in the
 * file, /api/config still answers `en` out of the runtime's MERGED defaults, so
 * the shell's China-first fallback (which only fires on a null) never gets a
 * turn and the app opens in English.
 *
 * main.ts closes that hole primarily by seeding config.yaml itself before the
 * backend spawns, which removes the race instead of racing it. This module is
 * the BACKSTOP for the residue: the seed could not write (read-only home, full
 * disk) or the home is re-created behind us, so the file is still absent at
 * boot and appears later anyway. Arm the live watcher, then run the same
 * idempotent, add-only guard, the moment the file lands.
 *
 * Polling rather than fs.watch on the directory, deliberately:
 *   - fs.watch cannot report a file that appeared between the existence check
 *     and the watch being armed, so it would need a poll to close its own race;
 *     a poll alone has no such gap.
 *   - directory watching is the least portable corner of fs.watch (recursive
 *     support, event coalescing, network/virtualised homes all differ per OS),
 *     and this path must be boringly deterministic on all three platforms.
 * The poll is free next to the seconds of backend cold start it runs alongside,
 * and it lands the heal well before the renderer can ask for /api/config: the
 * runtime writes config.yaml during startup, and the gateway only becomes
 * reachable after that. Even a late heal still counts — hermes_cli's
 * load_config() caches on (mtime_ns, size), so the next read picks up the file
 * we just touched rather than a stale parse.
 *
 * Electron-free (no `require('electron')`) so it unit-tests under
 * `vitest run --project electron`, same pattern as apex-managed.ts.
 */

import fs from 'node:fs'

type ConfigArrivalOptions = {
  configPath: string
  guard: () => void
  watch?: () => void
  pollMs?: number
  timeoutMs?: number
  // Only the one call this module makes, so a test can hand over a fake home
  // without stubbing all of node:fs.
  fsImpl?: { existsSync: (target: string) => boolean }
  log?: (line: string) => void
}

type ConfigArrivalOutcome = 'guarded' | 'timeout' | 'cancelled'

// Fast enough to be invisible next to a backend cold start, slow enough that
// the poll costs nothing on a home where the file never arrives.
const CONFIG_ARRIVAL_POLL_MS = 250

// Give up eventually so a session that legitimately never gets a local
// config.yaml (remote-gateway only, a backend that failed to start) doesn't
// keep a timer alive for the life of the app. Generous on purpose: a cold
// bootstrap install can spend minutes installing dependencies before the
// runtime writes anything at all.
const CONFIG_ARRIVAL_TIMEOUT_MS = 10 * 60_000

/**
 * Run `watch` then `guard` exactly once, as soon as `configPath` exists.
 *
 * `watch` goes FIRST so a writer that lands between our poll and our heal still
 * has an event to fire: the guard defers its write when the file changed under
 * it, and an armed watcher is what turns that deferral into a retry instead of
 * a loss.
 *
 * Callers get `done` (never rejects) mainly for tests; production is
 * fire-and-forget. `cancel()` is the teardown for a caller that stops caring.
 *
 * @param {ConfigArrivalOptions} options
 * @returns {{ cancel: () => void, done: Promise<ConfigArrivalOutcome> }}
 */
function guardConfigYamlOnArrival({
  configPath,
  guard,
  watch = () => {},
  pollMs = CONFIG_ARRIVAL_POLL_MS,
  timeoutMs = CONFIG_ARRIVAL_TIMEOUT_MS,
  fsImpl = fs,
  log = () => {}
}: ConfigArrivalOptions) {
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | null = null
  let settle: ((outcome: ConfigArrivalOutcome) => void) | null = null

  const done = new Promise<ConfigArrivalOutcome>(resolve => {
    settle = resolve
  })

  function finish(outcome: ConfigArrivalOutcome) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    if (settle) {
      const resolve = settle
      settle = null
      resolve(outcome)
    }
  }

  function schedule() {
    timer = setTimeout(tick, pollMs)

    // Never hold the process open waiting for a file that may never arrive.
    if (timer && typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  function tick() {
    timer = null

    let exists = false

    try {
      exists = fsImpl.existsSync(configPath)
    } catch {
      // An unreadable home is not our problem to solve here; keep polling
      // until the deadline in case it becomes readable.
      exists = false
    }

    if (exists) {
      // Both callbacks are already fail-soft in main.ts. The try still belongs
      // here so a throwing injected callback can never leave `done` pending.
      try {
        watch()
        guard()
      } catch (err: any) {
        log(`[config-guard] arrival pass failed: ${err && err.message ? err.message : err}`)
      }

      finish('guarded')

      return
    }

    if (Date.now() >= deadline) {
      log(`[config-guard] ${configPath} never appeared; product defaults were not reconciled this session`)
      finish('timeout')

      return
    }

    schedule()
  }

  schedule()

  return {
    cancel: () => finish('cancelled'),
    done
  }
}

export { CONFIG_ARRIVAL_POLL_MS, CONFIG_ARRIVAL_TIMEOUT_MS, guardConfigYamlOnArrival }
