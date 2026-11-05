/**
 * apex-chatcut.ts — the ChatCut launch switch (hc-1122).
 *
 * The switch is the platform client config's `desktop_features.chatcut`, off by
 * default; `APEXNODES_CHATCUT` overrides it for one install. Main settles it into
 * APEX_CHATCUT_ACTIVE=1 before the engine spawns, and the engine
 * (apex_overlay/chatcut.py) does the rest: an `mcp_servers` entry for the
 * Scheduler's ChatCut proxy, signed in with the APEX key the engine already has.
 * Off, the variable is removed, and that seam takes back the entry an earlier
 * launch wrote.
 *
 * Nothing about ChatCut is stored on this computer: the entry holds placeholders,
 * and APEX's ChatCut credential stays on the Scheduler. So a sign-out has nothing
 * of ChatCut's to clear here; the engine drops the entry at its next boot.
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

import { desktopFeatureOnForLaunch } from './apex-desktop-features'

/** Written by main for the engine; never an input. */
export const CHATCUT_ACTIVE_ENV = 'APEX_CHATCUT_ACTIVE'

export const CHATCUT_FEATURE = 'chatcut'

/** Settle the switch for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applyChatcutSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!desktopFeatureOnForLaunch(CHATCUT_FEATURE, env, clientConfigPayload)) {
    delete env[CHATCUT_ACTIVE_ENV]

    return false
  }

  env[CHATCUT_ACTIVE_ENV] = '1'
  log(`[client-config] ${CHATCUT_ACTIVE_ENV}=1 (desktop_features.chatcut)`)

  return true
}
