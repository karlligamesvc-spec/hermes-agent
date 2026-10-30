/**
 * hc-1122: the `desktop_features.chatcut` switch, for Settings.
 *
 * On, product mode's Settings gets a ChatCut page with the connection's state and
 * 断开 (app/settings/chatcut-settings.tsx). Connecting itself happens in the
 * conversation: the engine's `chatcut_connect` tool asks on a choice card. Off
 * unless something says on: the admin client config's literal `true`, or this
 * install's APEXNODES_CHATCUT=1 (`=0` keeps it off whatever the platform says),
 * which main hands over as `installSwitches` (electron/apex-desktop-features.ts).
 *
 * Nothing is persisted, so the off path writes nothing.
 */

import { atom } from 'nanostores'

import type { DesktopClientConfigState } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'

export const CHATCUT_FEATURE = 'chatcut'

/** The name in `mcp_servers`, the engine's `apex_overlay/chatcut.py` SERVER_NAME. */
export const CHATCUT_SERVER = 'chatcut'

export const $chatcutFlag = atom<boolean>(false)

/** The switch for one cached client-config state: an install switch wins, else the platform's literal `true`. */
export function chatcutSwitchFrom(
  state: null | Pick<DesktopClientConfigState, 'installSwitches' | 'payload'> | undefined
): boolean {
  const install = state?.installSwitches?.[CHATCUT_FEATURE]

  return typeof install === 'boolean' ? install : desktopFeatureOn(state?.payload, CHATCUT_FEATURE)
}

/** Read the switch now. Never throws: no bridge or a failed read keeps the value already held. */
export async function readChatcutFlag(): Promise<boolean> {
  try {
    const state = await window.hermesDesktop?.clientConfig?.get()

    if (state) {
      $chatcutFlag.set(chatcutSwitchFrom(state))
    }
  } catch {
    // A broken bridge is not the platform turning the feature off.
  }

  return $chatcutFlag.get()
}

/** Tests only: back to off. */
export function setChatcutFlagForTest(on: boolean): void {
  $chatcutFlag.set(on)
}
