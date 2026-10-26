/**
 * apex-hypihub.ts — APEX-hosted Hypit generation on the main-process side.
 *
 * The switch is the platform client config's `desktop_features.hypihub_apex`,
 * off by default. Unlike single_thread it has no install switch: the hosted
 * Endpoint is only useful once the Scheduler serves `/hypihub/v1/*`, so only
 * the platform turns it on. Main settles it into APEX_HYPIHUB_ACTIVE=1 before
 * the engine spawns; the terminal passes it to the `hypit` wrapper, which then:
 *
 *  - adds `hypihub.apex` (Hypit's own HypiHub Provider, based at the APEX
 *    Scheduler) to a NEW 0.3 project's Profile (apex_overlay/hypit_profile.py);
 *  - offers `hypit apex-enable-hosted` to add it to an existing APEX Profile;
 *  - fills the Profile's env Store slot APEX_HYPIHUB_TOKEN from the engine's
 *    platform-tool credential (apex_overlay/hypit_environment.mjs).
 *
 * Off, the variable is removed, so the Profile and the wrapper behave as
 * before the switch existed. Existing Profiles are never rewritten. Electron-free.
 */

import { desktopFeatureOnForLaunch } from './apex-desktop-features'

/** Written by main for the engine; never an input. */
export const HYPIHUB_APEX_ACTIVE_ENV = 'APEX_HYPIHUB_ACTIVE'

/** Settle the switch for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applyHypihubApexSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!desktopFeatureOnForLaunch('hypihub_apex', env, clientConfigPayload)) {
    delete env[HYPIHUB_APEX_ACTIVE_ENV]

    return false
  }

  env[HYPIHUB_APEX_ACTIVE_ENV] = '1'
  log(`[client-config] ${HYPIHUB_APEX_ACTIVE_ENV}=1 (desktop_features.hypihub_apex)`)

  return true
}
