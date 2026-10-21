/**
 * hc-1014 单线对话: the main chat's composer, gated. In single-thread product
 * mode only the thread takes messages; an earlier conversation (opened from
 * 「更早的对话」) is read-only, so a short bar with the way back stands where the
 * composer was. Everywhere else — the switch off, developer mode, the thread
 * itself, tiles (which import the composer directly) — this is the composer,
 * untouched.
 *
 * Decision 10 (old sessions into a read-only 「更早的对话」) is still Kael's to
 * make; this follows the plan's recommendation.
 */

import { useStore } from '@nanostores/react'
import type { ComponentProps } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { $mainThread, isMainThreadStoredId, type MainThreadState } from '@/store/main-thread'
import { $sessions } from '@/store/session'
import { $singleThreadMode } from '@/store/single-thread'
import type { SessionInfo } from '@/types/hermes'

import { ChatBarFallback, ChatBar as Composer } from '../chat/composer'
import { NEW_CHAT_ROUTE, sessionRoute } from '../routes'

import { $pendingThreadClaim } from './composer-middleware'

export { ChatBarFallback }

/** Is the conversation keyed `sessionKey` (its lineage root) an earlier, read-only one? */
export function isEarlierConversation(
  singleThread: boolean,
  sessionKey: null | string | undefined,
  thread: MainThreadState,
  sessions: readonly SessionInfo[],
  claimPending: boolean
): boolean {
  if (!singleThread || !sessionKey || claimPending) {
    return false
  }

  if (thread.status === 'absent') {
    return true
  }

  return thread.status === 'found' && !isMainThreadStoredId(sessionKey, thread, sessions)
}

export function ChatBar(props: ComponentProps<typeof Composer>) {
  const singleThread = useStore($singleThreadMode)
  const thread = useStore($mainThread)
  const sessions = useStore($sessions)
  const claimPending = Boolean(useStore($pendingThreadClaim))

  return isEarlierConversation(singleThread, props.queueSessionKey, thread, sessions, claimPending) ? (
    <EarlierConversationBar />
  ) : (
    <Composer {...props} />
  )
}

function EarlierConversationBar() {
  const copy = useSingleThreadChatCopy()
  const navigate = useNavigate()
  const thread = useStore($mainThread)

  return (
    <div
      className="absolute bottom-0 left-1/2 z-30 w-[min(var(--composer-width),calc(100%-2rem))] max-w-full -translate-x-1/2 pt-2 pb-(--composer-shell-pad-block-end)"
      data-single-thread-read-only=""
    >
      <div className="apex-composer-surface flex min-h-12 items-center justify-between gap-3 rounded-2xl border border-(--dt-input) bg-(--composer-fill) px-4 py-2 text-sm text-muted-foreground">
        <span className="min-w-0 truncate">{copy.readOnlyLine}</span>
        <Button
          onClick={() =>
            navigate(thread.status === 'found' && thread.tipId ? sessionRoute(thread.tipId) : NEW_CHAT_ROUTE)
          }
          size="sm"
          variant="outline"
        >
          {copy.backToThread}
        </Button>
      </div>
    </div>
  )
}
