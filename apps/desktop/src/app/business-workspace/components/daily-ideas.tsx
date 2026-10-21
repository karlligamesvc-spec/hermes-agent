import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import type { DesktopDailyIdeaCard, DesktopDailyIdeaDislikeReason, DesktopDailyIdeaKind } from '@/global'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { $authState } from '@/store/auth'
import { $dailyIdeas, dailyIdeasFor, dislikeDailyIdea, loadDailyIdeas, markDailyIdeaStarted } from '@/store/daily-ideas'

import { DAILY_IDEAS_COPY, dailyIdeaReadTime, type DailyIdeasCopy } from '../daily-ideas-copy'

export const DAILY_IDEA_REASONS: readonly DesktopDailyIdeaDislikeReason[] = ['not_my_direction', 'too_hard', 'skip_trend']

/** While today's hot ideas are being picked, the page is read again this often, a few times. */
export const DAILY_IDEAS_PENDING_REFRESH_MS = 20_000
export const DAILY_IDEAS_PENDING_REFRESH_LIMIT = 3

const PROFILE_SETTINGS_ROUTE = `${SETTINGS_ROUTE}?tab=config:personalization`

const KIND_CLASS: Record<DesktopDailyIdeaKind, string> = {
  hot: 'bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200',
  own: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-200',
  structure: 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
}

/**
 * hc-995 今日点子 on the Start page: three ideas the user can shoot today, picked
 * by the cloud from their creator profile (hc-991), this morning's hot lists and
 * videos they broke down. 开做 sends the card's prepared request into a new chat
 * (script and storyboard first, nothing generated); 不喜欢 asks why and swaps the
 * card; 换一批 shows the next three; 看来源 says where the 依据 came from. Hidden
 * unless the platform turns it on (`desktop_features.daily_ideas`).
 */
export function DailyIdeas({
  disabled = false,
  onStart
}: {
  disabled?: boolean
  /** Send the prepared request as the user's own chat message; resolves to whether chat took it. */
  onStart?: (prompt: string) => boolean | Promise<boolean>
}) {
  const { locale } = useI18n()
  const copy = DAILY_IDEAS_COPY[locale]
  const navigate = useNavigate()
  const { accountId, status } = useStore($authState)
  const page = dailyIdeasFor(useStore($dailyIdeas), accountId)
  const [turning, setTurning] = useState(false)
  const [refreshes, setRefreshes] = useState(0)
  const pending = page?.pending === true

  useEffect(() => {
    if (status === 'signed-in') {
      void loadDailyIdeas(accountId)
    }
  }, [accountId, status])

  useEffect(() => setRefreshes(0), [accountId])

  useEffect(() => {
    if (!pending || refreshes >= DAILY_IDEAS_PENDING_REFRESH_LIMIT) {
      return
    }

    const timer = window.setTimeout(() => {
      setRefreshes(count => count + 1)
      void loadDailyIdeas(accountId, $dailyIdeas.get().page?.page ?? 0)
    }, DAILY_IDEAS_PENDING_REFRESH_MS)

    return () => window.clearTimeout(timer)
  }, [accountId, pending, refreshes])

  if (!page || (page.cards.length === 0 && page.page === 0)) {
    return null
  }

  const turnTo = async (next: number) => {
    if (turning) {
      return
    }

    setTurning(true)

    try {
      await loadDailyIdeas(accountId, next)
    } finally {
      setTurning(false)
    }
  }

  const start = async (card: DesktopDailyIdeaCard) => {
    if (!disabled && (await onStart?.(card.startPrompt))) {
      markDailyIdeaStarted(accountId, card)
    }
  }

  const subtitle = pending
    ? copy.subtitlePending
    : !page.profile.complete || !page.profile.summary
      ? copy.subtitleNoProfile
      : page.cards.some(card => card.kind === 'hot')
        ? copy.subtitleHot(page.profile.summary)
        : copy.subtitleProfile(page.profile.summary)

  return (
    <section aria-label={copy.title} className="mt-6 flex flex-col gap-3" data-daily-ideas="">
      <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.02em] text-(--ui-text-primary)">{copy.title}</h2>
          <p className="m-0 mt-0.5 text-xs text-(--ui-text-tertiary)">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1">
          {page.more && (
            <Button disabled={turning} onClick={() => void turnTo(page.page + 1)} size="xs" type="button" variant="ghost">
              <Codicon name="refresh" size="0.75rem" />
              {turning ? copy.loadingMore : copy.more}
            </Button>
          )}
          <Button onClick={() => navigate(PROFILE_SETTINGS_ROUTE)} size="xs" type="button" variant="ghost">
            {page.profile.complete ? copy.editProfile : copy.fillProfile}
          </Button>
        </div>
      </header>
      {page.cards.length === 0 ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-3 text-sm"
          role="status"
        >
          <p className="m-0 text-(--ui-text-secondary)">{copy.allSeen}</p>
          <Button disabled={turning} onClick={() => void turnTo(0)} size="xs" type="button" variant="outline">
            {copy.backToFirst}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 @[38.8125rem]:grid-cols-3">
          {page.cards.map(card => (
            <IdeaCard
              card={card}
              copy={copy}
              disabled={disabled}
              key={card.id}
              onDislike={reason => dislikeDailyIdea(accountId, card, reason)}
              onStart={() => void start(card)}
            />
          ))}
        </div>
      )}
      <p className="m-0 text-xs text-(--ui-text-tertiary)">{copy.startNote}</p>
    </section>
  )
}

function IdeaCard({
  card,
  copy,
  disabled,
  onDislike,
  onStart
}: {
  card: DesktopDailyIdeaCard
  copy: DailyIdeasCopy
  disabled: boolean
  onDislike: (reason: DesktopDailyIdeaDislikeReason) => Promise<boolean>
  onStart: () => void
}) {
  const [sourceOpen, setSourceOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  // Only a hot list was read this morning; an own card's time is when the user broke the video down.
  const readAt = card.kind === 'hot' ? dailyIdeaReadTime(card.source.observedAt) : ''
  const source = card.source.label && readAt ? copy.sourceRead(card.source.label, readAt) : card.source.label

  const dislike = async (reason: DesktopDailyIdeaDislikeReason) => {
    setSending(true)
    setFailed(false)
    const taken = await onDislike(reason)
    // A card the cloud took away unmounts; one that stays says it did not work.
    setSending(false)
    setFailed(!taken)
  }

  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-4 shadow-xs"
      data-daily-idea={card.id}
      data-kind={card.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-1 text-xs leading-none font-medium ${KIND_CLASS[card.kind]}`}>
          {copy.kinds[card.kind]}
        </span>
        {card.started && (
          <span className="inline-flex items-center gap-0.5 text-xs text-(--ui-text-tertiary)" data-daily-idea-started="">
            <Codicon name="check" size="0.75rem" />
            {copy.started}
          </span>
        )}
      </div>
      <h3 className="m-0 text-sm leading-5 font-semibold text-(--ui-text-primary)">{card.title}</h3>
      {card.how && <p className="m-0 text-xs leading-5 text-(--ui-text-secondary)">{copy.how(card.how)}</p>}
      {card.why && <p className="m-0 text-xs leading-5 text-(--ui-text-secondary)">{copy.why(card.why)}</p>}
      {sourceOpen && source && (
        <p className="m-0 text-xs leading-5 text-(--ui-text-tertiary)" data-daily-idea-source="">
          {source}
          {card.source.url && (
            <>
              {' '}
              <Button onClick={() => openExternalLink(card.source.url ?? '')} size="inline" type="button" variant="text">
                {copy.openSource}
              </Button>
            </>
          )}
        </p>
      )}
      {asking ? (
        <div aria-label={copy.dislikeQuestion} className="mt-auto flex flex-col gap-1.5 pt-1" role="group">
          <p className="m-0 text-xs font-medium text-(--ui-text-primary)">{copy.dislikeQuestion}</p>
          <div className="flex flex-wrap gap-1.5">
            {DAILY_IDEA_REASONS.map(reason => (
              <Button
                disabled={sending}
                key={reason}
                onClick={() => void dislike(reason)}
                size="xs"
                type="button"
                variant="outline"
              >
                {copy.reasons[reason]}
              </Button>
            ))}
            <Button
              disabled={sending}
              onClick={() => {
                setAsking(false)
                setFailed(false)
              }}
              size="xs"
              type="button"
              variant="text"
            >
              {copy.cancel}
            </Button>
          </div>
          {failed && (
            <p className="m-0 text-xs text-destructive" role="alert">
              {copy.dislikeFailed}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Button disabled={disabled} onClick={onStart} size="xs" type="button">
            {copy.start}
          </Button>
          <Button disabled={disabled} onClick={() => setAsking(true)} size="xs" type="button" variant="ghost">
            {copy.dislike}
          </Button>
          {source && (
            <Button
              aria-expanded={sourceOpen}
              onClick={() => setSourceOpen(open => !open)}
              size="xs"
              type="button"
              variant="text"
            >
              {sourceOpen ? copy.hideSource : copy.showSource}
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
