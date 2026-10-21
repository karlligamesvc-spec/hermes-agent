/**
 * hc-1014 单线对话: when the one thread opens a new segment, and which line the
 * transcript draws between two turns.
 *
 * A segment is a compression rotation of the same thread: the runtime folds
 * the previous segment into a summary and the conversation goes on from it
 * (session.compress → `_compress_session_history`; the lineage, and the
 * transcript the desktop shows for it, stays one). A new one opens before the
 * first message of a new local day, after 6 idle hours, or when the user asks
 * to start over (「从头来」, `/new`). Every time here is epoch SECONDS, the unit
 * of `ChatMessage.timestamp`.
 */

/** Idle time after which the next message opens a new segment. */
export const IDLE_SEGMENT_SECONDS = 6 * 60 * 60

export type SegmentReason = 'day' | 'idle' | 'restart'

/** The local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDayKey(atSeconds: number): string {
  const at = new Date(atSeconds * 1000)
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')

  return `${at.getFullYear()}-${month}-${day}`
}

/** Does a message sent at `nowSeconds` open a new segment after the last one at `lastAtSeconds`? */
export function segmentBoundary(lastAtSeconds: null | number, nowSeconds: number): 'day' | 'idle' | null {
  if (lastAtSeconds === null || !Number.isFinite(lastAtSeconds) || lastAtSeconds <= 0) {
    return null
  }

  if (localDayKey(lastAtSeconds) !== localDayKey(nowSeconds)) {
    return 'day'
  }

  return nowSeconds - lastAtSeconds >= IDLE_SEGMENT_SECONDS ? 'idle' : null
}

/** The newest message time in a transcript, or null when nothing carries one. */
export function lastActivitySeconds(messages: readonly { timestamp?: number }[]): null | number {
  let last: null | number = null

  for (const message of messages) {
    const at = message.timestamp

    if (typeof at === 'number' && Number.isFinite(at) && at > 0 && (last === null || at > last)) {
      last = at
    }
  }

  return last
}

// 「从头来」 and friends, only at the start of the message (after a filler like
// 「好，」「那」「我们」) and only as a whole phrase: 「重来」「重新开始剪」 usually
// mean "redo that answer", which is not a new segment.
const RESTART_REQUEST =
  /^(?:(?:好[的吧啊]?|那么?|行|嗯)[，,。.\s]*)?(?:咱们|我们|先)?(?:从头来|从头开始|别管(?:刚才|之前|前面)的?|换个话题|start over|new topic)(?:吧|啊|呀|了)?(?:[，,。.!！?？\s]|$)/i

export function isRestartRequest(text: string): boolean {
  return RESTART_REQUEST.test(text.trim())
}

/** `/new` or `/reset` typed alone: in the one thread that means a new segment, not a new chat. */
export function isSlashNew(text: string): boolean {
  return /^\/(?:new|reset)\s*$/i.test(text.trim())
}

export type TurnDivider = { kind: 'date'; day: string } | { kind: 'segment' } | null

/**
 * The line above a turn that starts at `atSeconds`, after the previous
 * message at `prevAtSeconds`: a date on a new day (and above the first turn), a
 * 「新的一段」 line inside one day where a segment started, nothing otherwise.
 */
export function turnDivider(
  prevAtSeconds: null | number,
  atSeconds: null | number,
  segmentStarts: readonly number[]
): TurnDivider {
  if (atSeconds === null || !Number.isFinite(atSeconds) || atSeconds <= 0) {
    return null
  }

  if (prevAtSeconds === null || localDayKey(prevAtSeconds) !== localDayKey(atSeconds)) {
    return { kind: 'date', day: localDayKey(atSeconds) }
  }

  const started = segmentStarts.some(start => start > prevAtSeconds && start <= atSeconds)

  return started || atSeconds - prevAtSeconds >= IDLE_SEGMENT_SECONDS ? { kind: 'segment' } : null
}

/** A primitive key for a divider, so a selector can return it without re-rendering on every token. */
export function turnDividerKey(divider: TurnDivider): string {
  return divider === null ? '' : divider.kind === 'date' ? `date:${divider.day}` : 'segment'
}

/** The date parts a `date:YYYY-MM-DD` key names, with the year only when it is not `currentYear`. */
export function dividerDateParts(
  key: string,
  currentYear: number
): null | { day: number; month: number; weekday: number; year: null | number } {
  const match = /^date:(\d{4})-(\d{2})-(\d{2})$/.exec(key)

  if (!match) {
    return null
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]

  return { day, month, weekday: new Date(year, month - 1, day).getDay(), year: year === currentYear ? null : year }
}
