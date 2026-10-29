/**
 * hc-1101: the time line at the top of a message's right-click menu
 * (「今天 09:05」), as Muse shows it.
 *
 * A message that offers one carries `data-message-at` (epoch ms) on the element
 * a right-click lands in. Only single-thread product mode sets it, so anywhere
 * else no menu gains a line. The label is worked out when the menu opens, so
 * 「今天」 is still true after midnight.
 */

import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { messageTimeLabel } from '@/i18n/single-thread-messages'

export const MESSAGE_AT_ATTR = 'data-message-at'

/** The time line for a right-click on `element`, or undefined when it is not inside a message that offers one. */
export function menuCaptionFor(element: Element | null, now = new Date()): string | undefined {
  const at = Number(element?.closest(`[${MESSAGE_AT_ATTR}]`)?.getAttribute(MESSAGE_AT_ATTR))

  return at > 0 ? messageTimeLabel(getRuntimeI18nLocale(), new Date(at), now) : undefined
}
