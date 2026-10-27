/**
 * hc-1014 单线对话: what an empty thread shows instead of the Start page, in the
 * conversation's own column (decision 2: no Start page; the cards move into the
 * chat). Since hc-1063 that is prototype v2's 「第一次打开」 (first-open.tsx).
 * Nothing while the thread is still being looked up, so someone with a history
 * never sees a greeting flash before their conversation loads.
 */

import { useStore } from '@nanostores/react'
import { useLocation } from 'react-router'

import { $mainThread } from '@/store/main-thread'
import { $currentBotProfile, useMultiBotMode } from '@/store/single-thread-bots'

import { NEW_CHAT_ROUTE } from '../routes'

import { FirstOpen } from './first-open'

export function SingleThreadEmptyState() {
  const { profile, status } = useStore($mainThread)
  const { pathname } = useLocation()
  // hc-1077: while another assistant is being switched to, the thread on hand is the previous one's.
  const current = useStore($currentBotProfile)
  const otherBot = useMultiBotMode() && profile !== current
  // On `/` only an absent thread is really empty; a found one is about to open.
  const settled = pathname === NEW_CHAT_ROUTE ? status === 'absent' : status === 'found'

  if (!settled || otherBot) {
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
        <FirstOpen />
      </div>
    </div>
  )
}
