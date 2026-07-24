import { requestComposerInsert } from '../composer/focus'

import { isScenarioPickable, type ScenarioItem, scenarioPrefill } from './catalog'
import { requestScenarioSession } from './scenario-session-bridge'

/**
 * Prefill the main composer with a scenario's 口令 and focus it — the shared
 * action behind both the zero-state cards and the ✦ menu. Inline mode: on the
 * empty zero-state draft it sets the prefill; mid-conversation it appends so a
 * half-typed message is never destroyed.
 *
 * Before the prefill lands, a scenario session request goes out so the pick
 * gets a session named after the scenario (e.g. "拆一条视频"): reused in place
 * when the current session is still empty, or a fresh one when it already has
 * content — the desktop controller (which owns session lifecycle) makes that
 * call and queues the title (see `./scenario-session-bridge`). An unnamed
 * scenario (defensive — catalog names are normally non-empty) still gets the
 * session-or-reuse treatment, just with no title queued.
 *
 * A coming-soon scenario routes to nothing yet, so picking it is a no-op here
 * (the UI surfaces its note instead). Returns whether a prefill was inserted.
 */
export function insertScenarioPrefill(item: ScenarioItem): boolean {
  if (!isScenarioPickable(item)) {
    return false
  }

  requestScenarioSession(item.name)
  requestComposerInsert(scenarioPrefill(item), { mode: 'inline', target: 'main' })

  return true
}
