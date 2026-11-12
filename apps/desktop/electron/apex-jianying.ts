/**
 * apex-jianying.ts — the 剪映 draft launch switch (hc-1219).
 *
 * The switch is the platform client config's `desktop_features.jianying`, off by
 * default; `APEXNODES_JIANYING` overrides it for one install. Main settles it into
 * APEX_JIANYING_ACTIVE=1 before the engine spawns, and the engine
 * (apex_overlay/jianying_draft.py) then offers its `jianying_draft` tool while
 * 剪映专业版 is installed on this computer. Off, the variable is removed and the
 * engine registers nothing. The 「在剪映中打开」 button on a draft's card
 * (jianying.ts) needs no switch of its own: no card exists without the tool.
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

import { desktopFeatureOnForLaunch } from './apex-desktop-features'

/** Written by main for the engine; never an input. */
export const JIANYING_ACTIVE_ENV = 'APEX_JIANYING_ACTIVE'

export const JIANYING_FEATURE = 'jianying'

/** Settle the switch for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applyJianyingSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!desktopFeatureOnForLaunch(JIANYING_FEATURE, env, clientConfigPayload)) {
    delete env[JIANYING_ACTIVE_ENV]

    return false
  }

  env[JIANYING_ACTIVE_ENV] = '1'
  log(`[client-config] ${JIANYING_ACTIVE_ENV}=1 (desktop_features.jianying)`)

  return true
}
