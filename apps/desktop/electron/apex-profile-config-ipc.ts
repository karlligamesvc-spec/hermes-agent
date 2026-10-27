/**
 * apex-profile-config-ipc.ts — `hermes:apex:healProfileConfig` (hc-1080).
 *
 * The config guard heals every managed profile at boot, on every root
 * config.yaml change, after sign-in and when the relay's tier listing moves. A
 * profile created between those passes (hc-1078 creates one, then writes its
 * config) would wait for the next one; the renderer calls this right after so
 * the new assistant starts on the current relay key and the APEX blocks.
 *
 * Contract (renderer: `window.hermesDesktop.healApexProfileConfig?.(profile)`):
 * `profile` is the directory name under `profiles/` (`default` = the root).
 * Only a listed profile (apex-profile-homes.ts listProfileHomes) whose
 * config.yaml is on the managed relay is written, by the same add-only heal and
 * verified key write the guard runs; anything else resolves `ok: false` with a
 * reason and writes nothing.
 */

import fs from 'node:fs'

import type { IpcHandleRegistry } from './apex-account-reads'
import {
  accountTierInRoot,
  followedTier,
  guardProductBlocksInHome,
  persistRelayKeyInHome,
  type ProductBlocksContext
} from './apex-profile-config'
import { type ApexProfileHome, DEFAULT_PROFILE, listProfileHomes } from './apex-profile-homes'

export interface ProfileConfigHealResult {
  ok: boolean
  profile: string
  /** Why nothing was written (ok: false), or why the key could not be proven (ok: false after a heal). */
  reason?: string
  /** What the heal changed; empty when the file was already in step. */
  fixed: string[]
}

export interface ProfileConfigHealDeps {
  /** The root HERMES_HOME. */
  root: string
  /** The managed homes (main.ts apexConfigHomes). */
  homes: (managed: ProductBlocksContext['managed']) => ApexProfileHome[]
  /** The shared heal context; null while a Native model write is unresolved. */
  context: () => null | ProductBlocksContext
  /** After a write: restart pooled engines still on another relay key. */
  afterHeal?: (reason: string) => unknown
  log: (line: string) => void
}

const REASON = 'profile-heal'

/** Heal one profile's config.yaml now. Never throws. */
export function healProfileConfig(profile: unknown, deps: ProfileConfigHealDeps): ProfileConfigHealResult {
  const name = typeof profile === 'string' ? profile.trim() : ''
  const refuse = (reason: string): ProfileConfigHealResult => ({ ok: false, profile: name, reason, fixed: [] })

  // Matched against real directory entries, so `../x`, `a/b` or a hidden staging dir never resolve.
  const listed = listProfileHomes(deps.root).find(home => home.profile === name)

  if (!listed) {
    return refuse('unknown-profile')
  }

  if (!fs.existsSync(listed.configPath)) {
    return refuse('no-config')
  }

  const context = deps.context()

  if (!context) {
    return refuse('pending-model-writes')
  }

  const home = deps.homes(context.managed).find(candidate => candidate.profile === name)

  if (!home) {
    return refuse('not-managed')
  }

  // A named profile follows the root's tier, as in the guard.
  const rootHome = listProfileHomes(deps.root)[0]
  const accountTier = name === DEFAULT_PROFILE ? null : followedTier(home, accountTierInRoot(rootHome, context))
  const { fixed, outcome } = guardProductBlocksInHome(home, { ...context, accountTier }, REASON, deps.log)

  if (outcome === 'stale' || outcome === 'error' || outcome === 'absent') {
    return { ...refuse(outcome), fixed }
  }

  const { baseUrl, key } = context.managed
  const proven = baseUrl && key ? persistRelayKeyInHome(home, { baseUrl, key }, REASON, deps.log) : null

  if (fixed.length || proven?.changed) {
    deps.afterHeal?.(REASON)
  }

  if (proven && !proven.ok) {
    return { ...refuse(`relay-key: ${proven.reason}`), fixed }
  }

  return { ok: true, profile: name, fixed }
}

export function registerProfileConfigIpc(ipcMain: IpcHandleRegistry, deps: ProfileConfigHealDeps): void {
  ipcMain.handle('hermes:apex:healProfileConfig', async (_event, profile) => healProfileConfig(profile, deps))
}
