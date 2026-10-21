/**
 * hc-995 creator tips: what this device has already shown. Kept apart from
 * store/creator-tips.ts so store/tips.ts can reset it together with the UI tips
 * (Settings › 外观 › 应用内提示 › 恢复) without an import cycle.
 *
 * - `$creatorTipsSeen`: every creator tip that reached the screen. Each shows
 *   once; a new tip in the catalog is the only thing that brings tips back.
 * - `$creatorTipsDay`: how many showed on one local calendar day (cap 3).
 */

import { Codecs, persistentAtom } from '@/lib/persisted'

export interface CreatorTipsDay {
  count: number
  /** Local calendar day, YYYY-MM-DD; '' before the first tip. */
  day: string
}

const NO_DAY: CreatorTipsDay = { count: 0, day: '' }

function sanitizeDay(value: unknown): CreatorTipsDay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return NO_DAY
  }

  const { count, day } = value as Record<string, unknown>

  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && typeof count === 'number' && count >= 0
    ? { count: Math.floor(count), day }
    : NO_DAY
}

export const $creatorTipsSeen = persistentAtom<string[]>('hermes.desktop.creatorTips.seen.v1', [], Codecs.stringArray)

export const $creatorTipsDay = persistentAtom<CreatorTipsDay>(
  'hermes.desktop.creatorTips.day.v1',
  NO_DAY,
  Codecs.json(sanitizeDay)
)

export function resetCreatorTipsLedger(): void {
  $creatorTipsSeen.set([])
  $creatorTipsDay.set(NO_DAY)
}
