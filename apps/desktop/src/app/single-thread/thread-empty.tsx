/**
 * hc-1014 单线对话: what an empty thread shows instead of the Start page — two
 * lines from APEX and the hc-991 intake cards, in the conversation's own
 * column (decision 2: no Start page; the cards move into the chat). Nothing
 * while the thread is still being looked up, so someone with a history never
 * sees a greeting flash before their conversation loads.
 */

import { useStore } from '@nanostores/react'
import { useLocation } from 'react-router'

import { CreatorIntakeCards } from '@/app/business-workspace/components/creator-intake-cards'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { $mainThread } from '@/store/main-thread'

import { NEW_CHAT_ROUTE } from '../routes'

export function SingleThreadEmptyState() {
  const copy = useSingleThreadChatCopy()
  const { status } = useStore($mainThread)
  const { pathname } = useLocation()
  // On `/` only an absent thread is really empty; a found one is about to open.
  const settled = pathname === NEW_CHAT_ROUTE ? status === 'absent' : status === 'found'

  if (!settled) {
    return null
  }

  // The same clearance the Start splash keeps: the composer surface (and any
  // status stack on it) overlaps the bottom of this viewport.
  return (
    <div className="min-h-0 w-full overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        className="flex min-h-full w-full flex-col justify-end gap-3 pb-[calc(var(--composer-surface-measured-height)+var(--status-stack-measured-height)+1.5rem)]"
        data-single-thread-empty=""
      >
        <p className="max-w-[35rem] self-start rounded-2xl bg-(--ui-control-hover-background) px-4 py-2.5 text-[0.9375rem] leading-relaxed">
          {copy.greeting}
        </p>
        <p className="max-w-[35rem] self-start rounded-2xl bg-(--ui-control-hover-background) px-4 py-2.5 text-[0.9375rem] leading-relaxed">
          {copy.greetingHint}
        </p>
        <CreatorIntakeCards />
      </div>
    </div>
  )
}
