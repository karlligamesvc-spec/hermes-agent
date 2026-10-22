/**
 * hc-1014 单线对话: 「更早的对话」, the account menu's history destination in
 * single-thread product mode. It lists every conversation except the thread
 * itself; one opens read-only (composer-gate.tsx puts a bar with the way back
 * where the composer was). New messages only ever go to the thread.
 *
 * Decision 10, decided by Kael on 2026-10-21: old sessions are kept and
 * read-only, with their entry in the avatar (account) menu; they are not
 * stitched into the thread.
 */

import { useStore } from '@nanostores/react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { formatBusinessDayTime } from '@/lib/time'
import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $sessions } from '@/store/session'

import { BusinessPageHeader } from '../business-workspace/components/business-page-header'
import { openSession } from '../open-session'

export function EarlierConversationsView() {
  const { locale } = useI18n()
  const copy = useSingleThreadChatCopy()
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const thread = useStore($mainThread)

  const earlier = useMemo(
    () =>
      sessions
        .filter(session => !session.archived && !isMainThreadStoredId(session.id, thread, sessions))
        .sort((left, right) => right.last_active - left.last_active),
    [sessions, thread]
  )

  return (
    <section className="apex-business-surface apex-business-page apex-primary-page" data-single-thread-earlier="">
      <div className="apex-primary-page-column pt-4">
        <BusinessPageHeader
          description={copy.earlierDescription}
          eyebrow={copy.thread}
          icon="history"
          title={copy.earlierTitle}
        />
      </div>
      {earlier.length === 0 ? (
        <div className="mx-auto grid min-h-64 w-full max-w-[65.625rem] place-items-center py-10 text-center">
          <EmptyState title={copy.earlierEmpty} />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[65.625rem] space-y-1 py-5">
          {earlier.map(session => (
            <Button
              className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 text-left"
              key={session.id}
              onClick={() => openSession(session.id, navigate)}
              variant="ghost"
            >
              <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                <Codicon name="comment-discussion" />
              </span>
              <span className="min-w-0 self-center">
                <strong className="block truncate text-sm font-semibold">
                  {session.title?.trim() || session.preview?.trim() || copy.earlierUntitled}
                </strong>
              </span>
              <span className="self-center text-xs text-(--ui-text-tertiary)">
                {Number.isFinite(session.last_active) && session.last_active > 0
                  ? formatBusinessDayTime(new Date(session.last_active * 1000), locale)
                  : null}
              </span>
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}
