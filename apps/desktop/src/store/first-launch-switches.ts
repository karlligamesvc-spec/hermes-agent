/**
 * hc-1127: the window side of a brand-new install's first launch.
 *
 * Main fetches the platform config before it opens the first window
 * (electron/apex-client-config-sync.ts), so that window's read of the switches finds
 * it. When the fetch outlives main's wait, the config lands with this window already
 * open. Main says so once (`clientConfig.onArrived`), and never on an install that had
 * a config cached, whose switches go on counting from the next launch.
 */

import { settleSingleThreadFlagFrom } from '@/store/single-thread'
import { settleMultiBotFlagFrom } from '@/store/single-thread-bots'
import { settleMultiBotHandoffFlagFrom } from '@/store/single-thread-handoff'

/** The switches read once per window, and only those: capability-intro and daily-ideas read at the point of use. */
export function followLateClientConfig(): void {
  window.hermesDesktop?.clientConfig?.onArrived?.(state => {
    settleSingleThreadFlagFrom(state)
    settleMultiBotFlagFrom(state)
    settleMultiBotHandoffFlagFrom(state)
  })
}
