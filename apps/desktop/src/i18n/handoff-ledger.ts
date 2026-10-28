/**
 * hc-1090 多助手二期 R5: the 「最近发生的」 line a relay (接力) leaves in the
 * account's memory ledger when it comes back: who helped whom with what, and
 * the one point that matters from its 交回摘要. Every assistant reads the same
 * ledger, the WeChat APEX included (K1, K7), so any of them can bring it up.
 *
 * One line within the cloud's 100-character cap, cleaned the way the cloud
 * cleans it (apex-nodes app/services/memory_ledger.py `clean_content`), so the
 * length measured here is the length stored. Names only: an assistant's 分工
 * never goes in (hc-1082). Kept beside the main catalogs, which are past the
 * code-health size cap; zh, zh-hant and en are written out, ja and ar read en.
 */

import type { Locale } from './types'

/** The cloud's `content_max_chars` for one ledger entry, in code points. */
export const LEDGER_LINE_MAX_CHARS = 100

/** How much of the ask the line quotes, so the point still fits. */
export const LEDGER_ASK_MAX_CHARS = 24

/** Names are 1–12 characters on the roster; a longer one is cut rather than crowding the line out. */
const NAME_MAX_CHARS = 12

/** Below this much room the point is left out instead of cut to a stub. */
const POINT_MIN_CHARS = 8

interface LinePieces {
  ask: string
  from: string
  to: string
}

interface HandoffLedgerCopy {
  /** 「在电脑上，剪辑 帮 APEX 做完了「把口播剪成 30 秒」」 */
  bare: (pieces: LinePieces) => string
  /** The bare line plus the point from the 交回摘要. */
  full: (pieces: LinePieces & { point: string }) => string
}

const en: HandoffLedgerCopy = {
  bare: ({ ask, from, to }) => `On the computer, ${to} finished "${ask}" for ${from}`,
  full: ({ ask, from, point, to }) => `On the computer, ${to} finished "${ask}" for ${from}. Handed back: ${point}`
}

const zh: HandoffLedgerCopy = {
  bare: ({ ask, from, to }) => `在电脑上，${to} 帮 ${from} 做完了「${ask}」`,
  full: ({ ask, from, point, to }) => `在电脑上，${to} 帮 ${from} 做完了「${ask}」，交回：${point}`
}

const zhHant: HandoffLedgerCopy = {
  bare: ({ ask, from, to }) => `在電腦上，${to} 幫 ${from} 做完了「${ask}」`,
  full: ({ ask, from, point, to }) => `在電腦上，${to} 幫 ${from} 做完了「${ask}」，交回：${point}`
}

const COPY: Readonly<Record<Locale, HandoffLedgerCopy>> = { ar: en, en, ja: en, zh, 'zh-hant': zhHant }

const codePoints = (value: string) => [...value]

/**
 * The cloud's `clean_content`: what Python's `str.isprintable()` rejects becomes a
 * space (controls, format characters, line breaks, every space but ASCII's),
 * 【】<> go (they could close the prompt segment), whitespace runs collapse.
 */
export function cleanLedgerText(text: string): string {
  return text
    .replace(/(?! )[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}]/gu, ' ')
    .replace(/[【】<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** At most `max` code points, the last one an ellipsis when cut. */
function clipped(text: string, max: number): string {
  const chars = codePoints(text)

  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

const URL_RE = /\b(?:https?|file):\/\/\S+/gi
const MEDIA_RE = /MEDIA:\s*\S+/g
const LIST_MARK_RE = /^(?:[-*•]|\d+[.)、])\s*/
const SENTENCE_END_RE = /[。！？!?]|\.(?=\s|$)/u

/**
 * The 交回摘要's key point: its first line that says something, list marker and
 * Markdown emphasis off, links and files out (they live in the cards, not the
 * ledger), up to the end of its first sentence.
 */
export function handbackKeyPoint(summary: null | string | undefined): string {
  for (const raw of String(summary ?? '').split('\n')) {
    const line = cleanLedgerText(
      raw
        .replace(URL_RE, ' ')
        .replace(MEDIA_RE, ' ')
        .replace(/\*\*|__|`/g, '')
        .trim()
        .replace(LIST_MARK_RE, '')
    )

    if (!line) {
      continue
    }

    const end = SENTENCE_END_RE.exec(line)

    return end ? line.slice(0, end.index + end[0].length).trim() : line
  }

  return ''
}

export interface HandoffLedgerLines {
  /** With the point; the bare line when there is none or it does not fit. */
  full: string
  /** Who helped whom with what, without the point (the fallback when the cloud refuses the full line). */
  bare: string
}

export interface HandoffLedgerSource {
  ask: string
  /** The sender's name (the relay record's `from.name`). */
  fromName: string
  /** The receiver's name on the roster. */
  toName: string
  /** The 交回摘要 (the relay result's `summary`). */
  summary: string
}

/** The ledger line for a relay that came back, within {@link LEDGER_LINE_MAX_CHARS}. */
export function handoffLedgerLines(source: HandoffLedgerSource, locale: Locale): HandoffLedgerLines {
  const copy = COPY[locale] ?? en

  const pieces: LinePieces = {
    ask: clipped(cleanLedgerText(source.ask), LEDGER_ASK_MAX_CHARS),
    from: clipped(cleanLedgerText(source.fromName), NAME_MAX_CHARS),
    to: clipped(cleanLedgerText(source.toName), NAME_MAX_CHARS)
  }

  const bare = cleanLedgerText(copy.bare(pieces))
  const point = handbackKeyPoint(source.summary)
  const room = LEDGER_LINE_MAX_CHARS - codePoints(cleanLedgerText(copy.full({ ...pieces, point: '' }))).length

  if (!point || room < POINT_MIN_CHARS) {
    return { bare, full: bare }
  }

  return { bare, full: cleanLedgerText(copy.full({ ...pieces, point: clipped(point, room) })) }
}
