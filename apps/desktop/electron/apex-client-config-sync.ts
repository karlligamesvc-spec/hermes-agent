/**
 * apex-client-config-sync.ts — keeping the cached platform client config fresh,
 * and the one launch that has none (hc-1127).
 *
 * Everything that follows `desktop_features` reads the cached copy at launch: the
 * engine's environment (applyDesktopFeatureSwitches, before the engine spawns) and
 * the renderer's switches (once per window). A cached install keeps exactly that
 * contract: a newer config lands in the background and counts from the next launch.
 *
 * A launch with nothing cached has no earlier launch to lean on, and it is the first
 * thing a new user sees. So main fetches the config before it opens the first window,
 * for at most FIRST_LAUNCH_CONFIG_WAIT_MS. The window and the engine start together
 * (createWindow → startHermes), so holding that one call settles both.
 *
 * Past the wait the window opens with what it has, and the fetch keeps going. Should
 * the config land after that, the switches settle for whatever spawns next and the
 * open windows hear about it. That costs a new user nothing they can see: the login
 * screen covers the shell until sign-in, and sign-in waits once more before it commits
 * the new key. The engine restarts on that key, which puts a late switch into its env.
 *
 * Electron-free, like the other apex-* helpers; main.ts supplies the transports.
 */

import { fetchClientConfig, shouldApply } from './apex-client-config'

/**
 * The public endpoint takes about 0.85 s from a healthy connection, and the fetch's
 * own retry (after 200 ms) fits inside this too. Nothing is on screen while it runs,
 * so it stays well under what reads as a stuck launch.
 */
export const FIRST_LAUNCH_CONFIG_WAIT_MS = 2_500

export interface StoredClientConfig {
  appliedVersion: number
  fetchedAt: null | number
  payload: Record<string, unknown> | null
  version: number
}

export interface ClientConfigSyncOptions {
  apiBase: () => string
  /** Settle this launch's switches into the environment. */
  applySwitches: (payload: unknown) => void
  /** Tell the open windows a config arrived that they never read. */
  broadcast: (state: StoredClientConfig) => void
  fetchJson: (url: string, options?: object) => Promise<unknown>
  log: (line: string) => void
  read: () => StoredClientConfig
  waitMs?: number
  write: (next: StoredClientConfig) => void
}

export function createClientConfigSync({
  apiBase,
  applySwitches,
  broadcast,
  fetchJson,
  log,
  read,
  waitMs = FIRST_LAUNCH_CONFIG_WAIT_MS,
  write
}: ClientConfigSyncOptions) {
  const startedWithoutConfig = read().version === 0
  let firstFetch: null | Promise<void> = null
  let holdingFirstWindow = false

  // Fetch the platform config and store it when a NEWER version arrived.
  // Non-blocking by contract (callers `void` it), bounded (~5s), and never
  // throws — any error only logs and leaves the cached state untouched.
  async function fetchAndStore(reason: string): Promise<void> {
    try {
      const stored = read()

      const fetched = await fetchClientConfig({
        apiBase: apiBase(),
        fetchJson,
        knownVersion: stored.version,
        timeoutMs: 5_000,
        log
      })

      if (!fetched) {
        return
      } // offline / 404 no-active-config / garbage → cache stands

      if (fetched.unchanged) {
        log(`[client-config] v${fetched.version} unchanged (${reason})`)

        return
      }

      if (!shouldApply(fetched.version, stored.version)) {
        log(`[client-config] fetched v${fetched.version} is not newer than cached v${stored.version}; ignoring (${reason})`)

        return
      }

      const next = {
        version: fetched.version,
        payload: fetched.payload,
        fetchedAt: Date.now(),
        // Preserve what the renderer already applied — the gap between version
        // and appliedVersion is exactly what triggers the next apply pass.
        appliedVersion: stored.appliedVersion
      }

      write(next)
      log(`[client-config] stored platform config v${fetched.version} (${reason})`)

      // The launch's first config: nothing has read one yet. A cached install stops at
      // the write above, and a newer version counts from its next launch.
      if (stored.version === 0) {
        applySwitches(next.payload)
        broadcast(next)
      }
    } catch (error: any) {
      log(`[client-config] refresh failed (ignored): ${error && error.message ? error.message : error}`)
    }
  }

  /** A launch with nothing cached has one fetch in flight at a time, and every caller shares it. */
  function firstFetchFor(reason: string): Promise<void> {
    firstFetch ??= fetchAndStore(reason).finally(() => {
      firstFetch = null
    })

    return firstFetch
  }

  /** Wait for the launch's first config, for at most `waitMs`. Never rejects. */
  async function waitForFirstConfig(reason: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined

    await Promise.race([
      firstFetchFor(reason),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, waitMs)
      })
    ])
    clearTimeout(timer)
  }

  return {
    /** True while the first window is being held; a second launch must not open one meanwhile. */
    holdingFirstWindow: () => holdingFirstWindow,

    /** The platform check at boot and after sign-in. The first fetch is that launch's boot check. */
    refresh(reason: string): Promise<void> {
      if (reason === 'boot' && startedWithoutConfig) {
        return firstFetch ?? Promise.resolve()
      }

      return read().version === 0 ? firstFetchFor(reason) : fetchAndStore(reason)
    },

    /** Before the first window (and the engine it starts). Returns at once when a config is cached. */
    async settleBeforeFirstWindow(): Promise<void> {
      if (read().version > 0) {
        return
      }

      holdingFirstWindow = true
      await waitForFirstConfig('first-launch')
      holdingFirstWindow = false
    },

    /** Before sign-in commits the new key: the login screen stays up, and the engine restarts on it after this. */
    async settleBeforeSignInFinishes(): Promise<void> {
      if (read().version === 0) {
        await waitForFirstConfig('sign-in')
      }
    }
  }
}
