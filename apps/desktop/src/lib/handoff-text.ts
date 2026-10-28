/**
 * hc-1086 / hc-1088 (多助手二期 R1 / R3): the text of a relay (接力), protocol
 * `apex-handoff/1`, pinned in `apps/desktop/shared/apex-handoff-cases.json`.
 * The engine's tests read the same file (tests/apex_overlay/test_handoff_cases.py),
 * so change the two sides only together.
 *
 * - {@link composeHandoffRequest}: the hand-over message Desktop submits as a
 *   user message in the receiver's 「APEX 主线」 (`request`).
 * - {@link parseHandoffHeader}: which message is a hand-over (`request_header`);
 *   the runner finds its turn by the id in it.
 * - {@link parseHandback}: the 交回摘要 block the receiver ends its reply with,
 *   and the reply without it (`handback`).
 *
 * The engine carries the summary into the sender's next turn itself (its
 * return box); Desktop never pastes it into a message.
 */

import { stripNextStepBlocks } from '@/lib/next-steps'

export const HANDOFF_PROTOCOL = 'apex-handoff/1'

/** How much of the previous result goes along, in code points. */
export const HANDOFF_RESULT_MAX_CHARS = 2_000

/** Files and links listed in the hand-over, files first. */
export const HANDOFF_ITEMS_MAX = 20

export const HANDBACK_SUMMARY_MAX_CHARS = 600
export const HANDBACK_ITEMS_MAX = 10

/** Without a block, the return summary is the visible reply's first this many code points. */
export const HANDBACK_HEAD_MAX_CHARS = 300

const codePoints = (value: string) => [...value]

/** Line endings unified, leading blank lines and trailing whitespace dropped. */
function cleaned(text: null | string | undefined): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '')
}

/** Every line quoted: `> line` without its trailing spaces, a bare `>` for a blank one. */
function quoted(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The previous result as it goes along: blocks taken out, cleaned, its first {@link HANDOFF_RESULT_MAX_CHARS} code points. */
export function handoffCarryText(result: null | string | undefined): { text: string; truncated: boolean } {
  const chars = codePoints(cleaned(parseHandback(stripNextStepBlocks(String(result ?? ''))).visible))

  return { text: chars.slice(0, HANDOFF_RESULT_MAX_CHARS).join(''), truncated: chars.length > HANDOFF_RESULT_MAX_CHARS }
}

export interface HandoffRequestParts {
  /** The relay's id: 1–64 of [A-Za-z0-9_-]. */
  id: string
  /** The sender's profile id (`default` for APEX). */
  from: string
  fromName: string
  ask: string
  /** The previous result as {@link handoffCarryText} made it. */
  carry: { text: string; truncated: boolean }
  files: readonly string[]
  links: readonly string[]
}

/** The hand-over message from parts whose result was already carried. */
export function handoffRequestText(parts: HandoffRequestParts): string {
  const name = oneLine(parts.fromName)
  const items = [...parts.files, ...parts.links].map(item => String(item).trim()).filter(Boolean)

  const blocks = [
    `<!-- apex:handoff v=1 id=${parts.id} from=${parts.from} -->\n【${name} 交来的活】`,
    `要你做：\n${quoted(cleaned(parts.ask))}`
  ]

  if (parts.carry.text) {
    const label = parts.carry.truncated ? '上一条结果（前 2,000 字，后面没带）' : '上一条结果'

    blocks.push(`${name} ${label}：\n${quoted(parts.carry.text)}`)
  }

  if (items.length) {
    blocks.push(
      `里面的文件和链接：\n${items
        .slice(0, HANDOFF_ITEMS_MAX)
        .map(item => `- ${item}`)
        .join('\n')}`
    )
  }

  blocks.push(`来源：${name} 的对话`)

  return blocks.join('\n\n')
}

export interface HandoffRequestInput {
  id: string
  from: string
  fromName: string
  ask: string
  result: null | string
  files: readonly string[]
  links: readonly string[]
}

/** The hand-over message (`request` in the cases file). */
export function composeHandoffRequest(input: HandoffRequestInput): string {
  return handoffRequestText({ ...input, carry: handoffCarryText(input.result) })
}

const HEADER_RE = /^<!--\s*apex:handoff(?![A-Za-z0-9_])([^\n\r]*?)-->/
const HANDOFF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The hand-over a message is, from the header on its first line; null for any other message. */
export function parseHandoffHeader(text: null | string | undefined): { from: string; id: string } | null {
  const match = HEADER_RE.exec(String(text ?? '').replace(/^\s+/, ''))

  if (!match) {
    return null
  }

  const fields = new Map<string, string>()

  for (const token of match[1].split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=')
    const key = token.slice(0, eq)

    if (eq <= 0 || fields.has(key)) {
      return null
    }

    fields.set(key, token.slice(eq + 1))
  }

  const id = fields.get('id') ?? ''
  const from = fields.get('from') ?? ''

  return fields.get('v') === '1' && HANDOFF_ID_RE.test(id) && PROFILE_ID_RE.test(from) ? { from, id } : null
}

export interface HandbackBlock {
  summary: string
  files: string[]
  links: string[]
}

export interface ParsedHandback {
  /** The last usable block, or null. */
  block: HandbackBlock | null
  /** The reply with every block taken out; the reply as it was when nothing was. */
  visible: string
}

const HANDBACK_RE = /<!--\s*apex:handback(?![A-Za-z0-9_])([\s\S]*?)-->/g
const HANDBACK_MARKER = 'apex:handback'
const EMPTY_FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n`]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*(?:\n|$)/gm
const ITEM_RE = /^(?:[-*•]\s*)?(文件|链接|Files?|Links?)\s*[：:]\s*(.*)$/
const MARKDOWN_LINK_RE = /^\[[^\]]*\]\(([^)\s]+)\)$/

const WRAPPERS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
  ['《', '》'],
  ['`', '`'],
  ['<', '>']
]

function unwrapItem(raw: string): string {
  const value = raw.trim()
  const link = MARKDOWN_LINK_RE.exec(value)

  if (link) {
    return link[1]
  }

  for (const [left, right] of WRAPPERS) {
    if (value.length >= 2 && value.startsWith(left) && value.endsWith(right)) {
      return value.slice(left.length, value.length - right.length).trim()
    }
  }

  return value
}

function addItem(list: string[], value: string): void {
  if (value && !list.includes(value) && list.length < HANDBACK_ITEMS_MAX) {
    list.push(value)
  }
}

function handbackBody(body: string): HandbackBlock | null {
  const summary: string[] = []
  const files: string[] = []
  const links: string[] = []

  for (const raw of body.split('\n')) {
    const line = raw.trim()

    if (!line) {
      continue
    }

    const item = ITEM_RE.exec(line)

    if (!item) {
      summary.push(line)
    } else {
      addItem(item[1] === '文件' || item[1].startsWith('File') ? files : links, unwrapItem(item[2]))
    }
  }

  const chars = codePoints(summary.join('\n'))

  const text =
    chars.length > HANDBACK_SUMMARY_MAX_CHARS
      ? `${chars.slice(0, HANDBACK_SUMMARY_MAX_CHARS).join('')}…`
      : chars.join('')

  return text || files.length || links.length ? { files, links, summary: text } : null
}

/** Cut an unfinished block at the end (`<!-- apex:handback` with no `-->`, or half the marker). */
function cutUnfinishedTail(text: string): string {
  const start = text.lastIndexOf('<!--')

  if (start < 0 || text.includes('-->', start)) {
    return text
  }

  const tail = text.slice(start + 4).trim()

  return tail.startsWith(HANDBACK_MARKER) || (tail !== '' && HANDBACK_MARKER.startsWith(tail))
    ? text.slice(0, start)
    : text
}

/** The 交回摘要 in a reply (`handback` in the cases file), the same reading rules as the next-steps block. */
export function parseHandback(reply: null | string | undefined): ParsedHandback {
  const text = String(reply ?? '')

  if (!text.includes('<!--')) {
    return { block: null, visible: text }
  }

  let block: HandbackBlock | null = null

  for (const match of text.matchAll(HANDBACK_RE)) {
    block = handbackBody(match[1]) ?? block
  }

  const removed = text.replace(HANDBACK_RE, '')
  const visible = cutUnfinishedTail(removed === text ? removed : removed.replace(EMPTY_FENCE_RE, ''))

  return visible === text
    ? { block: null, visible: text }
    : { block, visible: visible.replace(/\n{3,}/g, '\n\n').trim() }
}

/** What a finished relay hands back: the block's summary (else the visible reply's opening), files and links. */
export function handbackResult(reply: string): HandbackBlock & { text: string } {
  const { block, visible } = parseHandback(reply)
  const head = codePoints(visible.trim()).slice(0, HANDBACK_HEAD_MAX_CHARS).join('')
  const seen = replyAttachments(visible)

  return {
    files: [...new Set([...(block?.files ?? []), ...seen.files])],
    links: [...new Set([...(block?.links ?? []), ...seen.links])],
    summary: block?.summary || head,
    text: visible
  }
}

const MEDIA_TAG_RE = /[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)[`"']?/g
const INLINE_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)\)/g
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()\]`"']+/g

function isLocalFile(href: string): boolean {
  return href.startsWith('/') || href.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(href)
}

/** The files (`MEDIA:` tags, links to local paths) and web links a reply names, each once, in order. */
export function replyAttachments(reply: string): { files: string[]; links: string[] } {
  const files = new Set<string>()
  const links = new Set<string>()

  for (const match of reply.matchAll(MEDIA_TAG_RE)) {
    files.add(unwrapItem(match[1]))
  }

  for (const match of reply.matchAll(INLINE_LINK_RE)) {
    if (/^https?:\/\//i.test(match[1])) {
      links.add(match[1])
    } else if (isLocalFile(match[1])) {
      files.add(match[1])
    }
  }

  for (const match of reply.replace(MEDIA_TAG_RE, ' ').matchAll(BARE_URL_RE)) {
    links.add(match[0].replace(/[.,;:!?。，；：！？]+$/u, ''))
  }

  return { files: [...files].filter(Boolean), links: [...links] }
}
