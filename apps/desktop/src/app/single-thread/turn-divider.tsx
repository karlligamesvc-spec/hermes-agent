/**
 * hc-1014 单线对话: the line above a turn — the date where a new day starts
 * (and above the first turn), 「新的一段」 where a segment started within a day.
 * The runtime already hands the desktop a compressed lineage as one transcript,
 * so the segments are joined into one timeline; this only marks the seams.
 * hc-1059 (prototype v2): a centred time line goes under each of them, and above
 * the first turn 「今天 14:20」 / 「昨天 14:52」 stands in for a date line.
 *
 * Renders nothing outside single-thread product mode: the selector returns ''
 * and no element is added, so the transcript's DOM is unchanged with the
 * switch off.
 */

import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'

import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { cn } from '@/lib/utils'
import { $threadSegmentStarts } from '@/store/main-thread'
import { useSingleThreadMode } from '@/store/single-thread'

import { dividerDateParts, turnDivider, turnDividerKey, type TurnTimeDay, turnTimeLine } from './segments'

function seconds(createdAt: unknown): null | number {
  return createdAt instanceof Date && Number.isFinite(createdAt.getTime()) ? createdAt.getTime() / 1000 : null
}

/** The divider key above the message at `index`: '' for none. */
export function turnDividerKeyAt(
  messages: readonly { createdAt?: unknown }[],
  index: number,
  segmentStarts: readonly number[]
): string {
  const at = seconds(messages[index]?.createdAt)
  const prev = index > 0 ? seconds(messages[index - 1]?.createdAt) : null

  return turnDividerKey(turnDivider(prev, at, segmentStarts))
}

/** The time line under the divider at `index`, as `day|seconds` (`day` empty or today/yesterday): '' for none. */
export function turnTimeKeyAt(
  messages: readonly { createdAt?: unknown }[],
  index: number,
  segmentStarts: readonly number[],
  nowSeconds: number
): string {
  const prev = index > 0 ? seconds(messages[index - 1]?.createdAt) : null
  const line = turnTimeLine(prev, seconds(messages[index]?.createdAt), segmentStarts, nowSeconds)

  return line === null ? '' : `${line.day ?? ''}|${line.at}`
}

const twoDigits = (value: number) => String(value).padStart(2, '0')

function TurnTime({ at, day }: { at: number; day: TurnTimeDay }) {
  const copy = useSingleThreadChatCopy()
  const when = new Date(at * 1000)
  const hhmm = `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`

  return (
    <time className="self-center text-center text-xs" data-turn-time="" dateTime={when.toISOString()}>
      {copy.turnTime({ day, hhmm })}
    </time>
  )
}

export function TurnDivider({ index }: { index: number }) {
  const singleThread = useSingleThreadMode()
  const segmentStarts = useStore($threadSegmentStarts)
  const key = useAuiState(s => (singleThread ? turnDividerKeyAt(s.thread.messages, index, segmentStarts) : ''))

  // Read with the clock inside the selector, so a new message after midnight
  // turns 「今天」 into 「昨天」 on the same pass that adds the new day's line.
  const timeKey = useAuiState(s =>
    singleThread ? turnTimeKeyAt(s.thread.messages, index, segmentStarts, Date.now() / 1000) : ''
  )

  const copy = useSingleThreadChatCopy()

  if (!key) {
    return null
  }

  const [day, at] = timeKey.split('|')
  const relative = day === 'today' || day === 'yesterday' ? day : null
  const time = at ? <TurnTime at={Number(at)} day={relative} /> : null

  if (relative) {
    return time
  }

  const date = dividerDateParts(key, new Date().getFullYear())
  const label = date ? copy.day(date) : copy.newSegment

  return (
    <>
      <TurnLine date={date !== null} label={label} />
      {time}
    </>
  )
}

function TurnLine({ date, label }: { date: boolean; label: string }) {
  return (
    <div
      aria-label={label}
      className={cn(
        'flex items-center gap-3 py-1 text-xs',
        date ? 'text-(--ui-text-tertiary)' : 'font-semibold text-primary'
      )}
      data-turn-divider={date ? 'date' : 'segment'}
      role="separator"
    >
      <span aria-hidden="true" className={cn('h-px flex-1', date ? 'bg-border' : 'bg-primary/30')} />
      <span aria-hidden="true">{label}</span>
      <span aria-hidden="true" className={cn('h-px flex-1', date ? 'bg-border' : 'bg-primary/30')} />
    </div>
  )
}
