/**
 * hc-1063: today's ideas inside the empty single thread, after the intake (the
 * prototype's 「那我先把今天能拍的备好」 and three cards). The same cards as the
 * Start page's hc-995 section — the cloud picks and words them, the store and
 * its switch are shared, so nothing shows unless `desktop_features.daily_ideas`
 * is on — drawn as the prototype draws them: tag, title, 怎么拍, 开做. 开做
 * sends the card's prepared request into this conversation, the way a next-step
 * button does. hc-1077 (K7): only APEX brings today's ideas; another assistant's
 * empty thread does not, so a day never has several sets.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import type { DesktopDailyIdeaCard } from '@/global'
import { useI18n } from '@/i18n'
import { useSingleThreadFirstOpenCopy } from '@/i18n/single-thread-first-open'
import { $authState } from '@/store/auth'
import { $dailyIdeas, dailyIdeasFor, loadDailyIdeas, markDailyIdeaStarted } from '@/store/daily-ideas'
import { $gatewayState } from '@/store/session'
import { $currentBot } from '@/store/single-thread-bots'

import {
  DAILY_IDEAS_PENDING_REFRESH_LIMIT,
  DAILY_IDEAS_PENDING_REFRESH_MS
} from '../business-workspace/components/daily-ideas'
import { DAILY_IDEAS_COPY, type DailyIdeasCopy } from '../business-workspace/daily-ideas-copy'
import { requestComposerSubmit } from '../chat/composer/focus'

/** APEX's lines in the empty thread: the same bubble the greeting has always used in this mode. */
export const FIRST_OPEN_BUBBLE_CLASS =
  'max-w-[35rem] self-start rounded-2xl bg-(--ui-control-hover-background) px-4 py-2.5 text-[0.9375rem] leading-relaxed'

export function FirstOpenIdeas() {
  const copy = useSingleThreadFirstOpenCopy()
  const ideasCopy = DAILY_IDEAS_COPY[useI18n().locale]
  const { accountId, status } = useStore($authState)
  const page = dailyIdeasFor(useStore($dailyIdeas), accountId)
  const gatewayOpen = useStore($gatewayState) === 'open'
  const otherBot = useStore($currentBot)?.isApex === false
  const [refreshes, setRefreshes] = useState(0)
  const pending = page?.pending === true

  useEffect(() => {
    if (status === 'signed-in') {
      void loadDailyIdeas(accountId)
    }
  }, [accountId, status])

  useEffect(() => setRefreshes(0), [accountId])

  // While today's hot ideas are still being picked, read again a few times (as the Start page does).
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

  const cards = page?.cards ?? []

  if (!page || cards.length === 0 || otherBot) {
    return null
  }

  const lead =
    !page.profile.complete || !page.profile.summary
      ? copy.ideasLead.plain
      : cards.some(card => card.kind === 'hot')
        ? copy.ideasLead.hot
        : copy.ideasLead.profile

  const start = (card: DesktopDailyIdeaCard) => {
    if (requestComposerSubmit(card.startPrompt, { target: 'main' })) {
      markDailyIdeaStarted(accountId, card)
    }
  }

  return (
    <>
      <p className={FIRST_OPEN_BUBBLE_CLASS}>{lead(cards.length)}</p>
      <div aria-label={copy.ideasGroup} className="@container w-full" data-first-open-ideas="" role="group">
        <div className="grid grid-cols-1 gap-2.5 @[34rem]:grid-cols-3">
          {cards.map(card => (
            <IdeaCard card={card} copy={ideasCopy} disabled={!gatewayOpen} key={card.id} onStart={() => start(card)} />
          ))}
        </div>
      </div>
    </>
  )
}

function IdeaCard({
  card,
  copy,
  disabled,
  onStart
}: {
  card: DesktopDailyIdeaCard
  copy: DailyIdeasCopy
  disabled: boolean
  onStart: () => void
}) {
  return (
    <article
      className="flex min-w-0 flex-col gap-1.5 rounded-[0.875rem] border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-3 text-[0.8125rem] leading-normal"
      data-daily-idea={card.id}
      data-kind={card.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-[0.3125rem] bg-primary/10 px-1.5 py-0.5 text-[0.71875rem] font-semibold text-primary">
          {copy.kinds[card.kind]}
        </span>
        {card.started && (
          <span className="inline-flex items-center gap-0.5 text-xs text-(--ui-text-tertiary)">
            <Codicon name="check" size="0.75rem" />
            {copy.started}
          </span>
        )}
      </div>
      <h3 className="m-0 text-sm leading-snug font-semibold text-(--ui-text-primary)">{card.title}</h3>
      {card.how && <p className="m-0 text-(--ui-text-secondary)">{copy.how(card.how)}</p>}
      <Button className="mt-auto self-start" disabled={disabled} onClick={onStart} size="xs" type="button">
        {copy.start}
      </Button>
    </article>
  )
}
