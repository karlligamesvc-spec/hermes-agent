/**
 * hc-1133: route overlays step aside while the sign-in screen is up.
 *
 * Settings is a modal dialog: while it is open the page takes no clicks and is
 * hidden from assistive tech, the login screen included, however high its z-index.
 * Settings › 账号 › 重新登录 opens that screen from inside Settings, and a 401 from
 * main, a refused send's toast or the IM binding can raise it over any overlay. So
 * while the screen is up an overlay renders nothing: it stays on its route and comes
 * back, on the same page, when the sign-in is finished or 「返回」 is pressed.
 *
 * Product mode only: developer mode and the switch off keep what they had.
 */

import { computed } from 'nanostores'

import { $authState } from './auth'
import { $managedReSignIn } from './managed-re-sign-in'
import { $singleThreadMode } from './single-thread'

/** The same states DesktopAuthGate covers the window for, with something on it to press. */
export const $overlaysYieldToSignIn = computed(
  [$singleThreadMode, $authState, $managedReSignIn],
  (productMode, { enabled, status }, request) => {
    if (!productMode || enabled !== true) {
      return false
    }

    return status === 'signed-in' || status === 'expired'
      ? request !== null
      : status === 'signed-out' || status === 'disabled'
  }
)
