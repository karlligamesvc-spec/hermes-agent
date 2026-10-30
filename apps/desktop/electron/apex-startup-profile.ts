/**
 * apex-startup-profile.ts — the profile the main engine starts as while
 * several assistants are off (hc-1115).
 *
 * active-profile.json names the profile Desktop launches its primary (window)
 * engine as. Upstream writes it from the developer profile rail
 * (`hermes:profile:remember` / `:set`) and from a heuristic that seeds a
 * missing file and re-scores its own picks on every launch: the profile whose
 * state.db is freshest and largest (profile-migration.ts). With several
 * assistants each one is a named profile with its own state.db, so the
 * heuristic can pick one of them, and a hand edit of a heuristic pick is
 * scored over again on the next launch.
 *
 * With single-thread on and several assistants off the screen shows APEX
 * only, which is the default profile. An engine started as another assistant
 * serves nobody, and APEX then needs a pool engine of its own: two engines for
 * one assistant. So, while single-thread is on and several assistants are off
 * for this launch (the env main settles before any engine spawns:
 * apex-single-thread.ts, apex-multi-bot.ts):
 *
 *  - every reader of the startup profile gets APEX's ({@link startupProfileFor}):
 *    the primary's `--profile` and pin, the renderer's `hermes:profile:get`,
 *    the local IM gateway, the plugin roots and the Feishu .env clean-up;
 *  - nothing records another profile as the startup one
 *    ({@link startupProfileWritable}), and the heuristic does not run
 *    ({@link migrateStartupProfileIfMissing}), so active-profile.json keeps
 *    what it held and the next launch with several assistants on starts as it
 *    would have.
 *
 * With several assistants on, or single-thread off, all of it passes through.
 * Main cannot see the renderer's developer mode, so it counts there too: a
 * profile picked on the developer rail still opens live, it just is not the
 * startup profile while several assistants are off. Electron-free.
 */

import fs from 'node:fs'

import { isMultiBotActive } from './apex-profile-homes'
import { isSingleThreadActive } from './apex-single-thread'
import { migrateActiveProfileIfMissing, type MigrationDeps, readExistingPreference } from './profile-migration'

/** APEX is the default profile: the root HERMES_HOME. */
export const APEX_STARTUP_PROFILE = 'default'

type Env = Record<string, string | undefined>

/** This launch shows APEX alone: single-thread on, several assistants off. */
export function apexOnlyStartup(env: Env): boolean {
  return isSingleThreadActive(env) && !isMultiBotActive(env)
}

/**
 * active-profile.json's `profile` when it is `default` or a name the engine
 * accepts, else null (missing or malformed = no preference).
 */
export function readStoredDesktopProfile(
  file: string,
  isValidProfileName: (name: string) => boolean,
  readFile: (file: string) => string = target => fs.readFileSync(target, 'utf8')
): null | string {
  try {
    const parsed = JSON.parse(readFile(file))
    const name = parsed && typeof parsed.profile === 'string' ? parsed.profile.trim() : ''

    if (name && (name === APEX_STARTUP_PROFILE || isValidProfileName(name))) {
      return name
    }
  } catch {
    // Missing or malformed → no preference.
  }

  return null
}

/** The startup profile for this launch: APEX's while it shows APEX alone, else what is stored. */
export function startupProfileFor(stored: null | string, env: Env): null | string {
  return apexOnlyStartup(env) ? APEX_STARTUP_PROFILE : stored
}

/**
 * Whether `profile` may be recorded as the startup profile. While APEX is
 * shown alone only APEX's (or clearing the choice) may; anything else is left
 * out, with one desktop.log line.
 */
export function startupProfileWritable(profile: null | string, env: Env, log: (line: string) => void): boolean {
  if (!apexOnlyStartup(env) || !profile || profile === APEX_STARTUP_PROFILE) {
    return true
  }

  log(`[multi-bot] off: not recording "${profile}" as the startup profile (it stays APEX's)`)

  return false
}

/**
 * The first-boot seed and heuristic re-score (profile-migration.ts), except
 * while APEX is shown alone: then it does not run and the file is not touched.
 */
export function migrateStartupProfileIfMissing(
  file: string,
  deps: MigrationDeps,
  env: Env,
  log: (line: string) => void
): boolean {
  if (apexOnlyStartup(env)) {
    const stored = deps.existsSync(file) ? readExistingPreference(file, deps.readFileSync)?.profile : null

    log(
      `[multi-bot] off: the main engine starts as APEX; active-profile.json (${stored ?? 'no profile'}) left as it is`
    )

    return false
  }

  return migrateActiveProfileIfMissing(file, deps)
}
