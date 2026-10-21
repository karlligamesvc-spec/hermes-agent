/**
 * apex-single-thread.ts — the single-thread switch on the main-process side
 * (hc-1015 「只有问题和回复」).
 *
 * The platform client config's `desktop_features.single_thread` (Kael
 * 2026-10-21; off by default, internal accounts first) is settled into
 * APEXNODES_SINGLE_THREAD at launch, before the engine spawns, like the hc-960
 * tier switches. Two readers depend on it:
 *
 *  - the engine: apex-overlay's `apex.single-thread` prompt section (no tool,
 *    skill or model names, one question at most, the name APEX) is on only
 *    while the variable is 1 (apex_overlay/single_thread_prompt.py);
 *  - the config heal: the managed model is pinned to the default tier alias,
 *    since nothing on screen lets the user pick another (apex-model-tiers.ts).
 *
 * The renderer reads the same cached config for the chat itself, with this
 * variable as the install switch beside it (hc-1014: src/store/single-thread.ts,
 * electron/apex-desktop-features.ts). An explicit 0/false in the env wins over
 * the platform, so one install can opt out; 1 turns it on for a tester. Set from
 * the platform here, it reads as that install switch too, so the chat and the
 * engine agree for the whole launch. Electron-free.
 */

import { DESKTOP_FEATURE_ENV, envSwitch } from './apex-desktop-features'

/** The same variable hc-1014 reads as this install's own switch. */
export const SINGLE_THREAD_ENV = DESKTOP_FEATURE_ENV.single_thread

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

export function isSingleThreadEnabled(env: Record<string, string | undefined> = {}): boolean {
  return envSwitch(env?.[SINGLE_THREAD_ENV]) === true
}

/** Settle the switch for this launch; returns whether it set the variable. */
export function applySingleThreadSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!singleThreadFromClientConfig(clientConfigPayload) || envSwitch(env?.[SINGLE_THREAD_ENV]) !== null) {
    return false
  }

  env[SINGLE_THREAD_ENV] = '1'
  log(`[client-config] ${SINGLE_THREAD_ENV}=1 from platform desktop_features`)

  return true
}
