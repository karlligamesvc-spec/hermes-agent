/**
 * hc-1086: the text a relay (接力) submits into the receiver's thread, and
 * what the runner reads back out of the reply.
 *
 * The wording of the request and the return-summary marker belong to R3
 * (hc-1088), pinned in `apps/desktop/shared/apex-handoff-cases.json` and read
 * by both its engine tests and this module's. Until that file lands,
 * {@link handoffRequestText} and {@link handoffReturnSummary} are PLACEHOLDERS
 * with no format of their own: the ask, the carried result, its files and
 * links, one block each; the summary is the reply's opening. Swap them for the
 * cases file, nothing else changes.
 *
 * Files and links in a reply are this module's own: `MEDIA:` tags (the
 * engine's file references) and Markdown links.
 */

import type { HandoffRecord } from '@/store/single-thread-handoff'

/** PLACEHOLDER (R3 owns the format): what the receiver's thread receives. */
export function handoffRequestText(record: Pick<HandoffRecord, 'ask' | 'carry'>): string {
  const { carry } = record

  return [record.ask, carry.text, carry.files.join('\n'), carry.links.join('\n')]
    .map(block => block.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** How much of the reply stands in for the summary until R3's marker exists. */
const SUMMARY_MAX_CHARS = 300

/** PLACEHOLDER (R3 owns the marker): the return summary read from the receiver's reply. */
export function handoffReturnSummary(reply: string): string {
  const chars = [...reply.trim()]

  return chars.length > SUMMARY_MAX_CHARS ? `${chars.slice(0, SUMMARY_MAX_CHARS).join('')}…` : chars.join('')
}

const MEDIA_TAG = /[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)[`"']?/g
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)\)/g
const BARE_URL = /\bhttps?:\/\/[^\s<>()\]`"']+/g

function unquote(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]

  return quote && quote === trimmed.at(-1) && ['"', "'", '`'].includes(quote) ? trimmed.slice(1, -1) : trimmed
}

function isWebLink(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

function isLocalFile(href: string): boolean {
  return href.startsWith('/') || href.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(href)
}

/** The files (local paths) and web links a reply names, each once, in order of appearance. */
export function handoffReplyAttachments(reply: string): { files: string[]; links: string[] } {
  const files = new Set<string>()
  const links = new Set<string>()

  for (const match of reply.matchAll(MEDIA_TAG)) {
    files.add(unquote(match[1]))
  }

  for (const match of reply.matchAll(MARKDOWN_LINK)) {
    const href = match[1]

    if (isWebLink(href)) {
      links.add(href)
    } else if (isLocalFile(href)) {
      files.add(href)
    }
  }

  for (const match of reply.replace(MEDIA_TAG, ' ').matchAll(BARE_URL)) {
    links.add(match[0].replace(/[.,;:!?。，；：！？]+$/u, ''))
  }

  return { files: [...files].filter(Boolean), links: [...links] }
}
