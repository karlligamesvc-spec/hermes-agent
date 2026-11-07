/**
 * Mirror of "which chats are mid-turn" to the main process.
 *
 * The renderer is the only side that knows a turn is in flight, and the main
 * process is the only side that can intercept a quit. This module bridges the
 * two: it publishes a small summary on every membership change, and
 * `electron/quit-guard.ts` turns that into the confirmation dialog.
 *
 * Imported for its side effect from `main.tsx`, alongside `store/translucency`.
 */

import { computed } from 'nanostores'

import type { HermesActiveWork } from '@/global'
import { $mainThreadsByProfile } from '@/store/main-thread'
import { $sessions } from '@/store/session'
import { $workingSessionIds } from '@/store/session-states'
import { $singleEngineFlag } from '@/store/single-engine'
import { $botRoster, botNameForProfile } from '@/store/single-thread-bots'
import { profileOfThreadStoredId } from '@/store/single-thread-presence'

/**
 * hc-1166: with one engine every assistant's turn is the quit's to stop, and
 * every assistant's thread has the same title, so the confirmation lists whose
 * turns they are — 「小红书文案」, not 「APEX 主线」 or "1 more".
 */
function assistantOf(storedId: string): null | string {
  return $singleEngineFlag.get() ? botNameForProfile(profileOfThreadStoredId(storedId)) : null
}

// hc-1100: `ids` also feeds the main process's ledger of turns a quit cuts off (electron/apex-turn-ledger.ts).
const $activeWork = computed(
  [$workingSessionIds, $sessions, $singleEngineFlag, $mainThreadsByProfile, $botRoster],
  (workingIds, sessions): HermesActiveWork & { ids: string[] } => {
    const titleById = new Map(sessions.map(session => [session.id, session.title?.trim() ?? '']))

    return {
      count: workingIds.length,
      ids: [...workingIds],
      titles: workingIds.map(id => assistantOf(id) ?? titleById.get(id) ?? '').filter(Boolean)
    }
  }
)

if (typeof window !== 'undefined') {
  // `$sessions` republishes on unrelated churn (previews, heartbeats), so only
  // send when the summary itself moved — this crosses a process boundary.
  let lastSent = ''

  $activeWork.subscribe(work => {
    const next = JSON.stringify(work)

    if (next === lastSent) {
      return
    }

    lastSent = next
    window.hermesDesktop?.setActiveWork?.(work)
  })
}
