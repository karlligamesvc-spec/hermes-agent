import { IS_MAC } from '@/lib/keybinds/combo'
import { isSingleThreadMode } from '@/store/single-thread'

import { closeActiveTab } from './close-tab'

/**
 * hc-1100: ⌘W and File › Close on macOS. Both reach the renderer as
 * `close-preview-requested` (main.ts gives File › Close no accelerator so ⌘W
 * gets here) and close the focused tab; the workspace tab itself never closes,
 * it empties into a fresh draft.
 *
 * Single-thread product mode has no tabs and no draft to empty into: the
 * conversation is the only thing on screen. So there the last rung closes the
 * window, the way every Mac app answers ⌘W. The app stays in the Dock with its
 * engines, a running turn goes on, and the Dock icon brings the window back
 * with the answer. A focused terminal or side zone still closes first.
 *
 * Developer mode, the switch off and Windows / Linux keep the tab rung: on
 * Windows closing the last window quits the app, which Ctrl+W must not do.
 */
export function closeActiveTabOrWindow(loadSessionIntoWorkspace?: (storedSessionId: string) => void): boolean {
  if (!IS_MAC || !isSingleThreadMode()) {
    return closeActiveTab(loadSessionIntoWorkspace)
  }

  return closeActiveTab(loadSessionIntoWorkspace, closeThisWindow)
}

/** Through main's `win.close()`, the red button's path ('close' fires, the geometry is saved). */
function closeThisWindow(): boolean {
  const bridge = window.hermesDesktop as unknown as undefined | { closeWindow?: () => void }

  if (bridge?.closeWindow) {
    bridge.closeWindow()
  } else {
    window.close()
  }

  return true
}
