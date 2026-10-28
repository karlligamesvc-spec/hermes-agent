/**
 * hc-1087: the protocol markers a message can carry that a reader never sees
 * as text, taken out at every plain-text exit (hard rule 12):
 *
 * - `<!-- apex:next … -->`: the 「下一步」 buttons (lib/next-steps.ts);
 * - `<!-- apex:handback … -->`: the 交回摘要 a relay's receiver ends its reply
 *   with (hc-1088, lib/handoff-text.ts `parseHandback`);
 * - `<!-- apex:handoff v=1 … -->`: the header that opens a relay's hand-over
 *   message in the receiver's thread (`parseHandoffHeader`).
 *
 * The exits are rendering (Markdown, a user bubble), copy, read-aloud,
 * streamed speech, the voice conversation and the turn-done notification;
 * hc-1087's PR lists every one. Like the 「下一步」 block, they go whatever the
 * switches say: they are protocol, never something to read out.
 */

import { parseHandback } from '@/lib/handoff-text'
import { createNextStepsSpeechFilter, type NextStepsSpeechFilter, stripNextStepBlocks } from '@/lib/next-steps'

const HANDBACK_MARKER = 'apex:handback'
const HANDBACK_RE = /<!--\s*apex:handback(?![A-Za-z0-9_])[\s\S]*?-->/g

// The hand-over header: opening the message, or a paragraph after a blank line, on one line (R3's request_header).
const HANDOFF_HEADER_RE =
  /(^[ \t\r\n]*|\n[ \t]*\n[ \t]*)<!--\s*apex:handoff(?![A-Za-z0-9_])[^\n\r]*?-->[ \t]*(?:\r?\n|$)/

/** The hand-over header taken out of a message (the first one, as the engine reads it); untouched when there is none. */
export function withoutHandoffHeader(text: string): string {
  if (!text.includes('apex:handoff')) {
    return text
  }

  return text.replace(HANDOFF_HEADER_RE, (_match, lead: string) => (lead.includes('\n\n') ? '\n\n' : ''))
}

/** What a reader may see of a message: every marker block gone. Untouched when there is none. */
export function visibleReplyText(text: string): string {
  const withoutNext = stripNextStepBlocks(text)

  if (!withoutNext.includes('<!--')) {
    return withoutNext
  }

  return withoutHandoffHeader(parseHandback(withoutNext).visible)
}

// What a streamed reply may end with while a block is still arriving: "<", "<!", "<!-".
const PARTIAL_OPENER_RE = /<(?:!-?)?$/

function openHandbackIndex(text: string): number {
  const start = text.lastIndexOf('<!--')

  if (start >= 0 && !text.includes('-->', start)) {
    const tail = text.slice(start + 4).trimStart()

    if (tail.startsWith(HANDBACK_MARKER) || HANDBACK_MARKER.startsWith(tail)) {
      return start
    }
  }

  const partial = PARTIAL_OPENER_RE.exec(text)

  return partial ? partial.index : -1
}

/** Streamed speech hears deltas: the 交回摘要 is held back as it arrives and dropped, like the 「下一步」 block. */
function createHandbackSpeechFilter(): NextStepsSpeechFilter {
  let pending = ''

  return {
    // End of the reply: an unfinished block is dropped (parseHandback cuts it), anything else is released.
    flush: () => {
      const rest = parseHandback(pending).visible

      pending = ''

      return rest
    },
    push: delta => {
      pending = (pending + delta).replace(HANDBACK_RE, '')
      const open = openHandbackIndex(pending)
      const ready = open < 0 ? pending : pending.slice(0, open)

      pending = open < 0 ? '' : pending.slice(open)

      return ready
    }
  }
}

/** The speech filter for a streamed reply: the 「下一步」 block and the 交回摘要 both held back and dropped. */
export function createReplyMarkersSpeechFilter(): NextStepsSpeechFilter {
  const next = createNextStepsSpeechFilter()
  const handback = createHandbackSpeechFilter()

  return {
    flush: () => handback.push(next.flush()) + handback.flush(),
    push: delta => handback.push(next.push(delta))
  }
}

const PREVIEW_BLOCK_RE = /<!--\s*apex:(?:handoff|handback|next)(?![A-Za-z0-9_])[\s\S]*?(?:-->|$)/g
// A search snippet cut inside a block: its tail up to the block's end, with no opener before it.
const PREVIEW_CUT_HEAD_RE = /^[^<]*?apex:(?:handoff|handback|next)(?![A-Za-z0-9_])[^<]*?-->/

/**
 * A one-line preview (a session's opening line, a search snippet) without the
 * markers: the engine flattens and cuts these, so a block may have lost its
 * line breaks, its start or its end. Untouched when no marker is in it.
 */
export function visiblePreviewText(text: string): string {
  if (!text.includes('apex:')) {
    return text
  }

  return text
    .replace(PREVIEW_CUT_HEAD_RE, '')
    .replace(PREVIEW_BLOCK_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Session rows with their previews read through {@link visiblePreviewText}; the same rows when none has a marker. */
export function withVisiblePreviews<T extends { preview?: null | string }>(rows: T[]): T[] {
  if (!rows.some(row => row.preview?.includes('apex:'))) {
    return rows
  }

  return rows.map(row => (row.preview?.includes('apex:') ? { ...row, preview: visiblePreviewText(row.preview) } : row))
}

/** Search results with their snippets read through {@link visiblePreviewText}; the same response when none has a marker. */
export function withVisibleSnippets<T extends { results: { snippet: string }[] }>(response: T): T {
  if (!response?.results?.some(result => result.snippet?.includes('apex:'))) {
    return response
  }

  return {
    ...response,
    results: response.results.map(result =>
      result.snippet?.includes('apex:') ? { ...result, snippet: visiblePreviewText(result.snippet) } : result
    )
  }
}
