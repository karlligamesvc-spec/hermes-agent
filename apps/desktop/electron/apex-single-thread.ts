/**
 * apex-single-thread.ts — single-thread mode on the main-process side
 * (hc-1015 「只有问题和回复」).
 *
 * hc-1014 owns the switch: the platform client config's
 * `desktop_features.single_thread`, or this install's own APEXNODES_SINGLE_THREAD
 * (1 on, 0 off, read as an input by electron/apex-desktop-features.ts and handed
 * to the renderer as `installSwitches`). This module never writes that variable.
 *
 * It settles the same decision once per launch — the install switch if set,
 * else the platform's literal `true` — into its own output variable,
 * APEX_SINGLE_THREAD_ACTIVE=1, before the engine spawns. Two readers depend on it:
 *
 *  - the engine: apex-overlay's `apex.single-thread` prompt section (no tool,
 *    skill or model names, one question with a default, the name APEX) is on
 *    only while it is 1 (apex_overlay/single_thread_prompt.py);
 *  - the config heal: the managed model is pinned to the default tier alias,
 *    since nothing on screen lets the user pick another (apex-model-tiers.ts).
 *
 * The engine does not see the renderer's developer mode; the prompt rules stay
 * on there too (developer mode only adds technical detail on screen). Electron-free.
 */

import { DESKTOP_FEATURE_ENV, envSwitch } from './apex-desktop-features'

/** Written by main for the engine; never an input. */
export const SINGLE_THREAD_ACTIVE_ENV = 'APEX_SINGLE_THREAD_ACTIVE'

/** Only a literal `true` under `desktop_features.single_thread` turns it on. */
export function singleThreadFromClientConfig(payload: unknown): boolean {
  const features =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { desktop_features?: unknown }).desktop_features
      : null

  return Boolean(
    features &&
    typeof features === 'object' &&
    !Array.isArray(features) &&
    (features as Record<string, unknown>).single_thread === true
  )
}

/** This launch's switch, decided as hc-1014 decides it: the install switch wins, else the platform. */
export function singleThreadOnForLaunch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown
): boolean {
  return envSwitch(env?.[DESKTOP_FEATURE_ENV.single_thread]) ?? singleThreadFromClientConfig(clientConfigPayload)
}

export function isSingleThreadActive(env: Record<string, string | undefined> = {}): boolean {
  return env?.[SINGLE_THREAD_ACTIVE_ENV] === '1'
}

/** Settle the engine's signal for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applySingleThreadSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!singleThreadOnForLaunch(env, clientConfigPayload)) {
    delete env[SINGLE_THREAD_ACTIVE_ENV]

    return false
  }

  env[SINGLE_THREAD_ACTIVE_ENV] = '1'
  log(`[client-config] ${SINGLE_THREAD_ACTIVE_ENV}=1 (desktop_features.single_thread)`)

  return true
}
