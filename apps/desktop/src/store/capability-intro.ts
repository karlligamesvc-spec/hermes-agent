/**
 * hc-1108 首启能力介绍: the `desktop_features.capability_intro` switch.
 *
 * On, APEX follows the three first-open cards with what it can do
 * (app/single-thread/capability-intro.tsx). Off unless something says on: the
 * admin client config's literal `true`, or this install's
 * APEXNODES_CAPABILITY_INTRO=1 (`=0` keeps it off whatever the platform says),
 * which main hands over as `installSwitches` (electron/apex-desktop-features.ts).
 *
 * Read when the first open may still finish its cards and again once they are
 * answered, not once per window: a new install's first launch can start
 * before main has fetched the platform config, and that launch is the one that
 * answers the cards. Each read is a local disk read through main, no network.
 * Nothing is persisted, so the off path writes nothing.
 */

import { atom } from 'nanostores'

import type { DesktopClientConfigState } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'

export const CAPABILITY_INTRO_FEATURE = 'capability_intro'

export const $capabilityIntroFlag = atom<boolean>(false)

/** The switch for one cached client-config state: an install switch wins, else the platform's literal `true`. */
export function capabilityIntroSwitchFrom(
  state: null | Pick<DesktopClientConfigState, 'installSwitches' | 'payload'> | undefined
): boolean {
  const install = state?.installSwitches?.[CAPABILITY_INTRO_FEATURE]

  return typeof install === 'boolean' ? install : desktopFeatureOn(state?.payload, CAPABILITY_INTRO_FEATURE)
}

/** Read the switch now. Never throws: no bridge or a failed read keeps the value already held. */
export async function readCapabilityIntroFlag(): Promise<boolean> {
  try {
    const state = await window.hermesDesktop?.clientConfig?.get()

    if (state) {
      $capabilityIntroFlag.set(capabilityIntroSwitchFrom(state))
    }
  } catch {
    // A broken bridge is not the platform turning the feature off.
  }

  return $capabilityIntroFlag.get()
}

/** Tests only: back to off. */
export function resetCapabilityIntroForTest(): void {
  $capabilityIntroFlag.set(false)
}
