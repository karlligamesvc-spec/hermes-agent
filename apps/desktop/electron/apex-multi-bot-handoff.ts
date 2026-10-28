/**
 * apex-multi-bot-handoff.ts — relay (接力) between assistants, on the
 * main-process side (hc-1086, 多助手二期 R1).
 *
 * The switch is the platform client config's `desktop_features.multi_bot_handoff`,
 * or this install's own APEXNODES_MULTI_BOT_HANDOFF (1 on, 0 off; read as an
 * input by apex-desktop-features.ts and handed to the renderer as
 * `installSwitches`). It only counts while several assistants are on for the
 * same launch (apex-multi-bot.ts: `multi_bot` plus single-thread), so a relay
 * never reaches a one-assistant or developer-shaped launch.
 *
 * Main settles the result into APEX_MULTI_BOT_HANDOFF_ACTIVE=1 before any
 * engine spawns; the primary and every pool backend spread process.env into
 * their spawn env, so each profile's engine sees the same value. The engine's
 * relay prompt sections (R3, hc-1088) read it. Off, the variable is removed.
 * The renderer applies the same rule plus its developer mode
 * (src/store/single-thread-handoff.ts). Electron-free.
 */

import { desktopFeatureOnForLaunch } from './apex-desktop-features'
import { multiBotOnForLaunch } from './apex-multi-bot'

export const MULTI_BOT_HANDOFF_FEATURE = 'multi_bot_handoff'

/** Written by main for the engine; never an input. */
export const MULTI_BOT_HANDOFF_ACTIVE_ENV = 'APEX_MULTI_BOT_HANDOFF_ACTIVE'

/** This launch's switch: multi_bot_handoff on (install switch first, else the platform's literal `true`) AND several assistants on. */
export function multiBotHandoffOnForLaunch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown
): boolean {
  return (
    multiBotOnForLaunch(env, clientConfigPayload) &&
    desktopFeatureOnForLaunch(MULTI_BOT_HANDOFF_FEATURE, env, clientConfigPayload)
  )
}

/** Settle the engine's signal for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applyMultiBotHandoffSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!multiBotHandoffOnForLaunch(env, clientConfigPayload)) {
    delete env[MULTI_BOT_HANDOFF_ACTIVE_ENV]

    return false
  }

  env[MULTI_BOT_HANDOFF_ACTIVE_ENV] = '1'
  log(`[client-config] ${MULTI_BOT_HANDOFF_ACTIVE_ENV}=1 (desktop_features.multi_bot_handoff)`)

  return true
}
