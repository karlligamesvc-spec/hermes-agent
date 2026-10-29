/**
 * hc-1107: the dot at the end of an assistant's sidebar row. While the
 * assistant waits on the user it is lit (a halo that breathes, still under
 * reduced motion) and says what it waits for; otherwise it is hc-1061's dot
 * for a reply not yet seen, exactly as it was. Waiting is not news: it stays
 * on with the conversation open, until the user answers.
 */

import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'

const DOT_CLASS = 'size-2 shrink-0 rounded-full bg-[#6A4CEB]'

export function RowDot({ unread, waiting }: { unread: boolean; waiting: null | string }) {
  const copy = useSingleThreadSidebarCopy()

  if (waiting) {
    return <span aria-label={waiting} className={`apex-waiting-dot ${DOT_CLASS}`} data-waiting-dot="" role="img" />
  }

  return unread ? <span aria-label={copy.unread} className={DOT_CLASS} role="img" /> : null
}
