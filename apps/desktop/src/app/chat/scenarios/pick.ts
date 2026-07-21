import { requestComposerInsert } from '../composer/focus'

import { isScenarioPickable, type ScenarioItem, scenarioPrefill } from './catalog'

/**
 * Prefill the main composer with a scenario's 口令 and focus it — the shared
 * action behind both the zero-state cards and the ✦ menu. Inline mode: on the
 * empty zero-state draft it sets the prefill; mid-conversation it appends so a
 * half-typed message is never destroyed.
 *
 * A coming-soon scenario routes to nothing yet, so picking it is a no-op here
 * (the UI surfaces its note instead). Returns whether a prefill was inserted.
 */
export function insertScenarioPrefill(item: ScenarioItem): boolean {
  if (!isScenarioPickable(item)) {
    return false
  }

  requestComposerInsert(scenarioPrefill(item), { mode: 'inline', target: 'main' })

  return true
}
