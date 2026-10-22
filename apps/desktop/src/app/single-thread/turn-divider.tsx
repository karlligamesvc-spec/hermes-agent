/**
 * hc-1014 单线对话: the line above a turn — the date where a new day starts
 * (and above the first turn), 「新的一段」 where a segment started within a day.
 * The runtime already hands the desktop a compressed lineage as one transcript,
 * so the segments are joined into one timeline; this only marks the seams.
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

import { dividerDateParts, turnDivider, turnDividerKey } from './segments'

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

export function TurnDivider({ index }: { index: number }) {
  const singleThread = useSingleThreadMode()
  const segmentStarts = useStore($threadSegmentStarts)
  const key = useAuiState(s => (singleThread ? turnDividerKeyAt(s.thread.messages, index, segmentStarts) : ''))
  const copy = useSingleThreadChatCopy()

  if (!key) {
    return null
  }

  const date = dividerDateParts(key, new Date().getFullYear())
  const label = date ? copy.day(date) : copy.newSegment

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
