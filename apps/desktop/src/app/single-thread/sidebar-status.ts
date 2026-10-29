/**
 * hc-1061 G3: the status line under an assistant's name in the single-thread
 * sidebar (the latest reply, what it is doing, 等你决定, 通话中). hc-1077 moved
 * it here from sidebar.tsx so every assistant's row reads it the same way.
 *
 * hc-1107: waiting on a yes/no reads 「等你确认」 (a choice stays 「等你决定」),
 * writing its answer 「正在回…」, a send that failed 「发送失败」 in red; the face
 * looks up at the user while it waits.
 */

import { useSingleThreadCopy, waitingLine } from '@/i18n/single-thread'
import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import type { ThreadPresence } from '@/store/single-thread-presence'

/** Working, waiting and in a call read in the avatar's purple, like the prototype's busy line. */
export const BUSY_LINE_CLASS = 'text-[#4127A8] dark:text-[#B9A8FF]'

/** hc-1107: 「发送失败」. */
const FAILED_LINE_CLASS = 'text-destructive'

/** The status line's colour for each state; quiet keeps the line's own grey. */
export function statusLineClass(kind: ThreadPresence['kind']): false | string {
  return kind === 'failed' ? FAILED_LINE_CLASS : kind !== 'idle' && BUSY_LINE_CLASS
}

/** The row's face: looking down at the work, looking up at the user while it waits on them. */
export function rowMood(kind: ThreadPresence['kind']): 'idle' | 'waiting' | 'working' {
  return kind === 'working' || kind === 'waiting' ? kind : 'idle'
}

/** The assistant row's status line for each state; null shows the name alone. */
export function useStatusLine(presence: ThreadPresence): null | string {
  const copy = useSingleThreadSidebarCopy()
  const threadCopy = useSingleThreadCopy()

  switch (presence.kind) {
    case 'call':
      return copy.inCall

    case 'failed':
      return copy.sendFailed

    case 'waiting':
      return waitingLine(threadCopy, presence.ask)

    case 'working':
      return presence.replying ? copy.replying : presence.text || copy.working

    default:
      return presence.text
  }
}
