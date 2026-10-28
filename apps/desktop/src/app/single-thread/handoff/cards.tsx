/**
 * hc-1087 多助手二期 R2: the relay (接力) cards, as prototype v2 artboards
 * ⑩–⑫ draw them. They only read hc-1086's records and call its actions; the
 * queue, the limits and the retries are the dispatcher's.
 *
 * - {@link HandoffConfirmCard}: before a relay starts — to whom, what it is
 *   asked, what goes along, the usage line (L2, L6).
 * - {@link HandoffRelayCard}: the sender's side, one per relay — queued (排第
 *   N), working, waiting on the user (jump to the receiver to answer), back
 *   (summary, files, 「打开它的对话」), failed (hc-973's three ways on), the
 *   platform busy (retried by itself), interrupted, stopped, cancelled
 *   (「X 已删除」, K9). 「停下」 while it is not over.
 * - {@link HandoffIncomingCard}: the receiver's side while the relay waits for
 *   it (its own turn is still running).
 * - {@link HandoffReceivedCard}: the receiver's side, in place of the
 *   hand-over message: 「X 交来的活」, its source a click away (⑪).
 * - {@link HandoffHandedBackLine}: under the receiver's reply once it went back.
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useState } from 'react'

import { ApexAvatar } from '@/components/apex-avatar'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { FailureActions } from '@/components/assistant-ui/process/process-block'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import {
  type HandoffCarryCount,
  handoffDuration,
  type SingleThreadHandoffCopy,
  useSingleThreadHandoffCopy
} from '@/i18n/single-thread-handoff'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import { $botRoster, type ApexBot, openBot } from '@/store/single-thread-bots'
import {
  $handoffs,
  carryFrom,
  forgetHandoff,
  handoffAccountOf,
  type HandoffCarry,
  handoffQueuePosition,
  type HandoffRecord,
  isHandoffActive,
  retryHandoff,
  stopHandoff
} from '@/store/single-thread-handoff'
import {
  $handoffReceiverNames,
  confirmHandoffProposal,
  dismissHandoffProposal,
  type HandoffProposal,
  proposeHandoff
} from '@/store/single-thread-handoff-confirm'

import type { HandoffRequestView } from './request-view'
import { handoffRetryBlocked, useHandoffUsageLine } from './usage-line'

const CARD_CLASS =
  'flex w-[30rem] max-w-full flex-col gap-2 self-start rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-3.5 py-3 text-[0.875rem] leading-relaxed text-(--ui-text-primary)'

const META_CLASS = 'm-0 text-xs leading-5 text-(--ui-text-tertiary)'

const QUOTE_CLASS =
  'm-0 rounded-[0.625rem] bg-(--ui-bg-tertiary) px-2.5 py-2 text-[0.8125rem] whitespace-pre-line wrap-anywhere text-(--ui-text-secondary)'

type ChipTone = 'done' | 'fail' | 'run' | 'wait'

const CHIP_CLASS: Record<ChipTone, string> = {
  done: 'bg-[color-mix(in_srgb,var(--ui-green)_14%,transparent)] text-(--ui-green)',
  fail: 'bg-[color-mix(in_srgb,var(--ui-red)_12%,transparent)] text-(--ui-red)',
  run: 'bg-[color-mix(in_srgb,var(--theme-primary)_12%,transparent)] text-primary',
  wait: 'bg-[color-mix(in_srgb,var(--ui-orange)_14%,transparent)] text-(--ui-orange)'
}

function Chip({ children, tone }: { children: ReactNode; tone: ChipTone }) {
  return (
    <span
      className={cn('shrink-0 rounded-full px-2 py-px text-xs font-semibold whitespace-nowrap', CHIP_CLASS[tone])}
      data-handoff-chip={tone}
    >
      {children}
    </span>
  )
}

function CardHead({ bot, children, title }: { bot: ApexBot | null; children?: ReactNode; title: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[0.90625rem] font-semibold">
      {bot && <ApexAvatar className="size-5.5" color={bot.color} shape={bot.shape} />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {children}
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}

function useBot(profile: string): ApexBot | null {
  return useStore($botRoster).find(bot => bot.profile === profile) ?? null
}

/** A file's name, a link's host: what one carried item reads as. */
export function itemLabel(item: string): string {
  if (/^https?:\/\//i.test(item)) {
    try {
      return new URL(item).host || item
    } catch {
      return item
    }
  }

  return item.split(/[\\/]/).filter(Boolean).at(-1) ?? item
}

const ITEMS_SHOWN = 4

function CarriedItems({ copy, items }: { copy: SingleThreadHandoffCopy; items: readonly string[] }) {
  if (!items.length) {
    return null
  }

  const shown = items.slice(0, ITEMS_SHOWN)

  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" data-handoff-items="">
      {shown.map(item => (
        <li
          className="max-w-full truncate rounded-md bg-(--ui-bg-tertiary) px-2 py-0.5 text-xs text-(--ui-text-secondary)"
          key={item}
          title={item}
        >
          {itemLabel(item)}
        </li>
      ))}
      {items.length > ITEMS_SHOWN && (
        <li className="px-1 py-0.5 text-xs text-(--ui-text-tertiary)">{copy.moreItems(items.length - ITEMS_SHOWN)}</li>
      )}
    </ul>
  )
}

export function carryCount(carry: HandoffCarry): HandoffCarryCount {
  return {
    chars: [...carry.text].length,
    files: carry.files.length,
    links: carry.links.length,
    truncated: carry.truncated
  }
}

/** The files and links that came back, drawn the way a reply draws them (media players, file cards, links). */
function ReturnedItems({ files, links }: { files: readonly string[]; links: readonly string[] }) {
  if (!files.length && !links.length) {
    return null
  }

  const markdown = [
    ...files.map(path => `[${itemLabel(path).replace(/[[\]]/g, '')}](#media:${encodeURIComponent(path)})`),
    ...links.map(link => `<${link}>`)
  ].join('\n\n')

  return (
    <div className="min-w-0" data-handoff-returned-items="">
      <MarkdownTextContent isRunning={false} text={markdown} />
    </div>
  )
}

// ── the confirm card ─────────────────────────────────────────────────────────

export function HandoffConfirmCard({ proposal }: { proposal: HandoffProposal }) {
  const copy = useSingleThreadHandoffCopy()
  const bot = useBot(proposal.input.to)
  const name = bot?.name ?? proposal.input.to
  const carry = carryFrom(proposal.input.previous)
  const ask = proposal.input.ask.trim()
  const usage = useHandoffUsageLine(1)
  const blocked = usage?.tone === 'blocked'
  // hc-1086 starts nothing until the first sign-in check says whose relay it is.
  const accountPending = handoffAccountOf(useStore($authState)) === undefined
  const refusal = proposal.refusal ?? (ask ? null : 'empty')
  const note = blocked && usage?.blockedReason ? usage.blockedReason : refusal ? copy.refusal(refusal, name) : null

  return (
    <section aria-label={copy.confirmTitle(name)} className={CARD_CLASS} data-handoff-card="confirm">
      <CardHead bot={bot} title={copy.confirmTitle(name)} />
      {ask && (
        <p className="m-0 whitespace-pre-line wrap-anywhere">
          <span className="me-1.5 text-(--ui-text-tertiary)">{copy.askLabel}</span>
          {ask}
        </p>
      )}
      <p className={META_CLASS}>{copy.carryLine(carryCount(carry))}</p>
      <CarriedItems copy={copy} items={[...carry.files, ...carry.links]} />
      {usage && (
        <p
          className={cn(
            'm-0 rounded-[0.5625rem] bg-(--ui-bg-tertiary) px-2.5 py-1.5 text-xs leading-5',
            usage.tone === 'normal' ? 'text-(--ui-text-secondary)' : 'text-(--ui-orange)'
          )}
          data-handoff-usage={usage.tone}
        >
          {usage.text}
        </p>
      )}
      {usage?.warning && !blocked && (
        <p className="m-0 text-xs leading-5 text-(--ui-orange)" data-handoff-usage-warning="">
          {usage.warning}
        </p>
      )}
      {note && (
        <p className="m-0 text-xs text-destructive" role="alert">
          {note}
        </p>
      )}
      {accountPending && !note && <p className={META_CLASS}>{copy.accountPending}</p>}
      <Actions>
        <Button
          disabled={blocked || !ask || accountPending}
          onClick={() => confirmHandoffProposal()}
          size="sm"
          type="button"
        >
          {copy.confirm}
        </Button>
        <Button onClick={dismissHandoffProposal} size="sm" type="button" variant="outline">
          {copy.notNow}
        </Button>
      </Actions>
    </section>
  )
}

// ── the sender's relay card ──────────────────────────────────────────────────

interface StatusView {
  chip: ReactNode
  body: ReactNode
  actions: ReactNode
}

function relayStatus(
  record: HandoffRecord,
  name: string,
  copy: SingleThreadHandoffCopy,
  position: null | number,
  retry: () => void
) {
  const open = () => void openBot(record.to).catch(() => undefined)
  const stop = () => void stopHandoff(record.id)
  const close = () => forgetHandoff(record.id)

  const closeButton = (
    <Button onClick={close} size="sm" type="button" variant="ghost">
      {copy.close}
    </Button>
  )

  switch (record.status) {
    case 'queued': {
      const busyRetry = record.queueReason === 'platform_busy_retry'

      return {
        actions: (
          <Actions>
            <Button onClick={open} size="sm" type="button" variant="outline">
              {copy.seeWork}
            </Button>
            <Button onClick={stop} size="sm" type="button" variant="outline">
              {copy.stopQueued}
            </Button>
          </Actions>
        ),
        body: <p className={META_CLASS}>{copy.queueNote(record.queueReason, name)}</p>,
        chip: busyRetry ? (
          <Chip tone="wait">{copy.platformBusyChip}</Chip>
        ) : (
          <Chip tone="wait">{copy.queuedChip(position ?? 1)}</Chip>
        )
      }
    }

    case 'running':
      return {
        actions: (
          <Actions>
            <Button onClick={open} size="sm" type="button" variant="outline">
              {copy.seeWork}
            </Button>
            <Button onClick={stop} size="sm" type="button" variant="outline">
              {copy.stop}
            </Button>
          </Actions>
        ),
        body: null,
        chip: <Chip tone="run">{copy.runningChip}</Chip>
      }

    case 'waiting':
      return {
        actions: (
          <Actions>
            <Button onClick={open} size="sm" type="button">
              {copy.answer}
            </Button>
            <Button onClick={stop} size="sm" type="button" variant="outline">
              {copy.stop}
            </Button>
          </Actions>
        ),
        body: <p className="m-0 wrap-anywhere">{copy.waitingNote(name, record.waitingFor?.question.trim() ?? '')}</p>,
        chip: <Chip tone="wait">{copy.waitingChip}</Chip>
      }
    case 'returned': {
      const took = handoffDuration(
        copy,
        record.startedAt && record.finishedAt ? record.finishedAt - record.startedAt : null
      )

      return {
        actions: (
          <Actions>
            <Button onClick={open} size="sm" type="button" variant="outline">
              {copy.openThread(name)}
            </Button>
            {closeButton}
          </Actions>
        ),
        body: (
          <>
            {record.result?.summary && <p className={QUOTE_CLASS}>{record.result.summary}</p>}
            <ReturnedItems files={record.result?.files ?? []} links={record.result?.links ?? []} />
          </>
        ),
        chip: <Chip tone="done">{copy.returnedChip(took)}</Chip>
      }
    }

    case 'failed':
      return {
        actions: null,
        body: <FailedBody copy={copy} name={name} onRetry={retry} record={record} />,
        chip: <Chip tone="fail">{record.failure?.kind === 'interrupted' ? copy.interruptedChip : copy.failedChip}</Chip>
      }

    case 'stopped':
      return {
        actions: (
          <Actions>
            <Button onClick={retry} size="sm" type="button" variant="outline">
              {copy.retry}
            </Button>
            {closeButton}
          </Actions>
        ),
        body: <p className={META_CLASS}>{copy.stoppedNote}</p>,
        chip: <Chip tone="wait">{copy.stoppedChip}</Chip>
      }

    default:
      return {
        actions: <Actions>{closeButton}</Actions>,
        body: <p className={META_CLASS}>{copy.cancelled(record.cancelReason ?? 'receiver_deleted', name)}</p>,
        chip: <Chip tone="fail">{copy.cancelledChip}</Chip>
      }
  }
}

/** hc-973's three ways on, for a relay: 再试一次 runs the same relay again; the other two hand the same receiver a new sentence (through the confirm card). */
function FailedBody({
  copy,
  name,
  onRetry,
  record
}: {
  copy: SingleThreadHandoffCopy
  name: string
  onRetry: () => void
  record: HandoffRecord
}) {
  const { t } = useI18n()
  const failure = t.assistant.tool.process.failure
  const title = [...record.ask.replace(/\s+/g, ' ').trim()].slice(0, 20).join('')

  const onAsk = (message: string) => {
    if (message === failure.retryMessage(title)) {
      onRetry()

      return
    }

    proposeHandoff(
      {
        ask: message,
        from: record.from,
        previous: { files: record.carry.files, links: record.carry.links, text: record.carry.text },
        to: record.to
      },
      { origin: 'next_step' }
    )
  }

  return (
    <>
      <p className="m-0 wrap-anywhere">{copy.failure(record.failure?.kind ?? 'turn_error', name)}</p>
      <FailureActions disabled={false} onAsk={onAsk} title={title} />
    </>
  )
}

export function HandoffRelayCard({ record }: { record: HandoffRecord }) {
  const copy = useSingleThreadHandoffCopy()
  const bot = useBot(record.to)
  const position = handoffQueuePosition(record.id, useStore($handoffs))
  const names = useStore($handoffReceiverNames)
  // A deleted receiver keeps the name it had when the relay started (K9: 「X 已删除」).
  const name = bot?.name ?? names[record.to] ?? record.to
  const [held, setHeld] = useState<null | string>(null)

  // 「再试一次」 runs a turn without a card: a used-up allowance (R5) keeps the relay where it is and says why.
  const retry = () =>
    void handoffRetryBlocked().then(reason => {
      setHeld(reason)

      if (!reason) {
        retryHandoff(record.id)
      }
    })

  const status: StatusView = relayStatus(record, name, copy, position, retry)

  return (
    <section
      aria-label={copy.cardTitle(name)}
      className={CARD_CLASS}
      data-handoff-card="relay"
      data-handoff-id={record.id}
      data-handoff-status={record.status}
    >
      <CardHead bot={bot} title={copy.cardTitle(name)}>
        {status.chip}
      </CardHead>
      <p className={QUOTE_CLASS}>{record.ask}</p>
      {isHandoffActive(record) && <p className={META_CLASS}>{copy.carried(carryCount(record.carry))}</p>}
      {status.body}
      {held && !isHandoffActive(record) && (
        <p className="m-0 text-xs text-destructive" role="alert">
          {held}
        </p>
      )}
      {status.actions}
    </section>
  )
}

// ── the receiver's side ──────────────────────────────────────────────────────

export function HandoffIncomingCard({ record }: { record: HandoffRecord }) {
  const copy = useSingleThreadHandoffCopy()
  const sender = useBot(record.from.profile)
  const fromName = sender?.name ?? record.from.name ?? record.from.profile
  const position = handoffQueuePosition(record.id, useStore($handoffs))

  return (
    <section aria-label={copy.receivedTitle(fromName)} className={CARD_CLASS} data-handoff-card="incoming">
      <CardHead bot={sender} title={copy.receivedTitle(fromName)}>
        <Chip tone="wait">{copy.queuedChip(position ?? 1)}</Chip>
      </CardHead>
      <p className="m-0 whitespace-pre-line wrap-anywhere">{record.ask}</p>
      <p className={META_CLASS}>{copy.receivedQueued}</p>
    </section>
  )
}

export function HandoffReceivedCard({ fromProfile, view }: { fromProfile: string; view: HandoffRequestView }) {
  const copy = useSingleThreadHandoffCopy()
  const sender = useBot(fromProfile)
  const fromName = sender?.name ?? view.fromName

  return (
    <section aria-label={copy.receivedTitle(fromName)} className={CARD_CLASS} data-handoff-card="received">
      <CardHead bot={sender} title={copy.receivedTitle(fromName)}>
        {sender && (
          <Button
            onClick={() => void openBot(fromProfile).catch(() => undefined)}
            size="xs"
            type="button"
            variant="outline"
          >
            {copy.backTo(fromName)}
          </Button>
        )}
      </CardHead>
      <p className="m-0 whitespace-pre-line wrap-anywhere">{view.ask}</p>
      {view.previous && (
        <div className="grid gap-1">
          <span className={META_CLASS}>{copy.previousLabel(fromName)}</span>
          <p className={cn(QUOTE_CLASS, 'line-clamp-6')}>{view.previous}</p>
        </div>
      )}
      <CarriedItems copy={copy} items={view.items} />
      <p className={META_CLASS}>{copy.receivedNote(fromName)}</p>
    </section>
  )
}

const twoDigits = (value: number) => String(value).padStart(2, '0')

export function HandoffHandedBackLine({ record }: { record: HandoffRecord }) {
  const copy = useSingleThreadHandoffCopy()
  const sender = useBot(record.from.profile)
  const when = new Date(record.result?.at ?? record.finishedAt ?? Date.now())
  const hhmm = `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`

  return (
    <p
      className="m-0 flex items-center justify-center gap-1.5 self-center text-xs text-(--ui-text-tertiary)"
      data-handoff-handed-back=""
    >
      <svg aria-hidden="true" className="size-3.5 text-(--ui-green)" fill="none" viewBox="0 0 24 24">
        <path
          d="M5 12.5l4.5 4.5L19 7.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.6"
        />
      </svg>
      <span>{copy.handedBack(sender?.name ?? record.from.name ?? record.from.profile, hhmm)}</span>
    </p>
  )
}
