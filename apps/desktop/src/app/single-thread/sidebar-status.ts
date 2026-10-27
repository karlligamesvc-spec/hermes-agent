/**
 * hc-1061 G3: the status line under an assistant's name in the single-thread
 * sidebar (the latest reply, what it is doing, 等你决定, 通话中). hc-1077 moved
 * it here from sidebar.tsx so every assistant's row reads it the same way.
 */

import { useSingleThreadCopy } from '@/i18n/single-thread'
import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import type { ThreadPresence } from '@/store/single-thread-presence'

/** Working, waiting and in a call read in the avatar's purple, like the prototype's busy line. */
export const BUSY_LINE_CLASS = 'text-[#4127A8] dark:text-[#B9A8FF]'

/** The assistant row's status line for each state; null shows the name alone. */
export function useStatusLine(presence: ThreadPresence): null | string {
  const copy = useSingleThreadSidebarCopy()
  const waiting = useSingleThreadCopy().waitingForYou

  switch (presence.kind) {
    case 'call':
      return copy.inCall

    case 'waiting':
      return waiting

    case 'working':
      return presence.text || copy.working

    default:
      return presence.text
  }
}
