import { computed } from 'nanostores'

import { $newSessionTabAction } from '@/components/pane-shell/tree/store'
import { $singleThreadMode } from '@/store/single-thread'

/**
 * hc-1014: the zone tab strip's "+" (a fresh session tab) is a second
 * conversation, so single-thread product mode offers none; otherwise it is the
 * action the wiring registered.
 */
export const $newConversationTabAction = computed([$newSessionTabAction, $singleThreadMode], (action, singleThread) =>
  singleThread ? null : action
)
