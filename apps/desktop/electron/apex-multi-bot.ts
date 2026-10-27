/**
 * apex-multi-bot.ts — several assistants in single-thread mode, on the
 * main-process side (hc-1077, 多助手第一期 M1).
 *
 * One assistant is one Hermes profile: APEX is the default profile, every other
 * assistant a named one with its own 「APEX 主线」. The switch is the platform
 * client config's `desktop_features.multi_bot`, or this install's own
 * APEXNODES_MULTI_BOT (1 on, 0 off; read as an input by
 * apex-desktop-features.ts and handed to the renderer as `installSwitches`).
 * It only counts while single-thread mode is on for the same launch: several
 * assistants are a single-thread product shape, never a developer-mode one.
 *
 * Main settles the result into APEX_MULTI_BOT_ACTIVE=1 before any engine
 * spawns; the primary and every pool backend spread process.env into their
 * spawn env, so each profile's engine sees the same value. The engine reads it
 * for the assistant's own name and the rename tool (hc-1082). Off, the variable
 * is removed. The renderer applies the same rule plus its developer mode
 * (src/store/single-thread-bots.ts). Electron-free.
 */

import { desktopFeatureOnForLaunch } from './apex-desktop-features'
import { singleThreadOnForLaunch } from './apex-single-thread'

export const MULTI_BOT_FEATURE = 'multi_bot'

/** Written by main for the engine; never an input. */
export const MULTI_BOT_ACTIVE_ENV = 'APEX_MULTI_BOT_ACTIVE'

/** This launch's switch: multi_bot on (install switch first, else the platform's literal `true`) AND single-thread on. */
export function multiBotOnForLaunch(env: Record<string, string | undefined>, clientConfigPayload: unknown): boolean {
  return (
    singleThreadOnForLaunch(env, clientConfigPayload) &&
    desktopFeatureOnForLaunch(MULTI_BOT_FEATURE, env, clientConfigPayload)
  )
}

/** Settle the engine's signal for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applyMultiBotSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!multiBotOnForLaunch(env, clientConfigPayload)) {
    delete env[MULTI_BOT_ACTIVE_ENV]

    return false
  }

  env[MULTI_BOT_ACTIVE_ENV] = '1'
  log(`[client-config] ${MULTI_BOT_ACTIVE_ENV}=1 (desktop_features.multi_bot)`)

  return true
}
