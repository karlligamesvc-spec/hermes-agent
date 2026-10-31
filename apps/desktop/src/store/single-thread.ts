/**
 * hc-1014 单线对话: the `desktop_features.single_thread` switch.
 *
 * One person, one conversation: with the switch on, the product shell opens
 * straight into the assistant's one thread — no Start page, no session list,
 * no new-chat button. 开发者模式 (Settings › 外观, `$toolViewMode === 'technical'`)
 * keeps today's entries, so `$singleThreadMode` is the switch AND product mode.
 * hc-1015 and hc-1016 hang their product-mode changes off the same atom.
 *
 * Off unless something says on: the admin client config's
 * `desktop_features.single_thread === true` (one global row, so it turns the
 * feature on for every install), or this install's APEXNODES_SINGLE_THREAD=1
 * (`=0` keeps it off whatever the platform says), which main hands over as
 * `installSwitches` (electron/apex-desktop-features.ts).
 */

import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'

import type { DesktopClientConfigState } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'
import { persistBoolean, storedBoolean } from '@/lib/storage'
import { $toolViewMode } from '@/store/tool-view'

export const SINGLE_THREAD_FEATURE = 'single_thread'

/** The value this install last settled on, so the next launch paints the right
 *  shell before the config read lands. Global: the switch belongs to the install. */
export const SINGLE_THREAD_HINT_KEY = 'apex.desktop.feature.single-thread'

/** The switch as read: admin client config or this install's own switch. */
export const $singleThreadFlag = atom<boolean>(storedBoolean(SINGLE_THREAD_HINT_KEY, false))

/** Product single-thread mode — what every hc-1014/1015/1016 product change reads. */
export const $singleThreadMode = computed(
  [$singleThreadFlag, $toolViewMode],
  (on, toolView) => on && toolView !== 'technical'
)

export function isSingleThreadMode(): boolean {
  return $singleThreadMode.get()
}

export function useSingleThreadMode(): boolean {
  return useStore($singleThreadMode)
}

/** The switch for one cached client-config state: an install switch wins, else the platform's literal `true`. */
export function singleThreadSwitchFrom(
  state: null | Pick<DesktopClientConfigState, 'installSwitches' | 'payload'> | undefined
): boolean {
  const install = state?.installSwitches?.[SINGLE_THREAD_FEATURE]

  return typeof install === 'boolean' ? install : desktopFeatureOn(state?.payload, SINGLE_THREAD_FEATURE)
}

function settle(on: boolean): void {
  $singleThreadFlag.set(on)
  persistBoolean(SINGLE_THREAD_HINT_KEY, on)
}

let reading: null | Promise<boolean> = null

/**
 * Read the switch once per window (a local disk read through main, no network);
 * every later call shares that read. Never throws: no bridge or a failed read
 * keeps the value already held.
 */
export function loadSingleThreadFlag(): Promise<boolean> {
  reading ??= (async () => {
    try {
      const state = await window.hermesDesktop?.clientConfig?.get()

      if (state) {
        settle(singleThreadSwitchFrom(state))
      }
    } catch {
      // Keep the hint: a broken bridge is not the platform turning the feature off.
    }

    return $singleThreadFlag.get()
  })()

  return reading
}

/** hc-1127: a config that landed after this window's read. The next read asks main again. */
export function settleSingleThreadFlagFrom(state: DesktopClientConfigState): void {
  reading = null
  settle(singleThreadSwitchFrom(state))
}

/** Tests only: forget the read and set the switch. */
export function setSingleThreadFlagForTest(on: boolean): void {
  reading = null
  settle(on)
}

// Read as soon as anything in the window imports the switch, so readers outside
// React (slash commands, keybindings) see the settled value too.
void loadSingleThreadFlag()
