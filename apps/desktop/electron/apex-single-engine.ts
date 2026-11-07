/**
 * apex-single-engine.ts — several assistants on one engine (hc-1166).
 *
 * With several assistants on (hc-1077), every assistant is a Hermes profile
 * and, by default, Desktop starts a pool engine per profile: a click on an
 * assistant whose engine is not running waits for a Python process to boot
 * (「正在唤醒 …」), and a full pool evicts one to make room. The engine itself
 * can host many profiles in one `serve` process: each call names its
 * `profile`, and the engine binds that profile's HERMES_HOME, secrets, state.db,
 * SOUL and skills for it (tui_gateway/server.py `_profile_home`, the route the
 * global-remote shared primary already uses).
 *
 * The switch is the platform client config's `desktop_features.multi_bot_single_engine`,
 * or this install's own APEXNODES_MULTI_BOT_SINGLE_ENGINE (1 on, 0 off;
 * apex-desktop-features.ts). It only counts while several assistants are on for
 * the same launch. Main settles it into APEX_MULTI_BOT_SINGLE_ENGINE=1 before
 * any engine spawns; the profile route (connection-config.ts
 * `localSharedPrimary`) and the startup profile (apex-startup-profile.ts) read
 * it from there. Off, the variable is removed and every assistant keeps a pool
 * engine of its own, as before. Electron-free.
 */

import { desktopFeatureOnForLaunch } from './apex-desktop-features'
import { multiBotOnForLaunch } from './apex-multi-bot'
import { SINGLE_ENGINE_ACTIVE_ENV } from './apex-profile-homes'

export const SINGLE_ENGINE_FEATURE = 'multi_bot_single_engine'

/** This launch's switch: several assistants on AND multi_bot_single_engine on (install switch first, else the platform's literal `true`). */
export function singleEngineOnForLaunch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown
): boolean {
  return (
    multiBotOnForLaunch(env, clientConfigPayload) &&
    desktopFeatureOnForLaunch(SINGLE_ENGINE_FEATURE, env, clientConfigPayload)
  )
}

/** Settle this launch's signal: 1 when on, removed when off. Returns whether it is on. */
export function applySingleEngineSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!singleEngineOnForLaunch(env, clientConfigPayload)) {
    delete env[SINGLE_ENGINE_ACTIVE_ENV]

    return false
  }

  env[SINGLE_ENGINE_ACTIVE_ENV] = '1'
  log(`[client-config] ${SINGLE_ENGINE_ACTIVE_ENV}=1 (desktop_features.multi_bot_single_engine)`)

  return true
}
