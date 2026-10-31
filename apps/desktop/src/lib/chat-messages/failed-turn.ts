/**
 * hc-1116: the row the engine writes under a failed turn, in single-thread
 * product mode.
 *
 * The engine closes a turn that ended without a reply with a fixed English
 * row (`display_kind: 'failed_turn'`, agent/turn_failure_copy.py). Live, the
 * error card stands in for it; when the conversation is opened again, the
 * row is what is left, and it read "Your request was not processed…" to a
 * Chinese user. In product mode it says the same thing in the app's language.
 * Developer mode and single-thread off keep the engine's row as written.
 */

import { singleThreadUpstreamCopyNow } from '@/i18n/single-thread-upstream-copy'
import { isSingleThreadMode } from '@/store/single-thread'

/** agent/turn_failure_copy.py FAILED_TURN_NOTICE: the turn stopped before any step ran. */
export const ENGINE_FAILED_TURN_NOTICE =
  'Your request was not processed. Send it again if you still want me to carry it out.'

export const FAILED_TURN_DISPLAY_KIND = 'failed_turn'

/**
 * What a failed-turn row shows. Anything but the engine's "not processed"
 * notice (its partial notice, or wording a newer engine writes) says some
 * steps may already have run: the safe claim when it is not known.
 */
export function failedTurnDisplayText(content: string): string {
  if (!isSingleThreadMode()) {
    return content
  }

  const copy = singleThreadUpstreamCopyNow()

  return content.trim() === ENGINE_FAILED_TURN_NOTICE ? copy.failedTurn : copy.failedTurnPartial
}
