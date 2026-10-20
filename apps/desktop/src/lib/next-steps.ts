/**
 * 「下一步」块 (apex-next/1) — the Desktop half of apex-nodes
 * `docs/NEXT-STEPS-BLOCK-PROTOCOL.md`.
 *
 * A creator skill ends a result with an HTML comment:
 *
 *   <!-- apex:next
 *   存进选题库 | 把这 5 个选题存进我的选题库
 *   写成脚本 | 把第 1 个选题写成 60 秒口播脚本
 *   -->
 *
 * one option per line (`button text | the sentence a click sends`, at most 3), or,
 * when the result failed, `<!-- apex:next failed=生成视频 -->` (the hc-973 three).
 * An HTML comment never renders in Markdown, so a build without this module shows
 * nothing rather than the raw block.
 *
 * `parseNextSteps` gives the same answer as the `apexnodes-next-steps` plugin (and the
 * scheduler backstop) on the shared fixture `next-steps.fixtures.json`, which apex-nodes CI
 * keeps byte-identical to its own copy. Every plain-text exit strips the block: Markdown
 * (`preprocessMarkdown`), copy, read-aloud, streamed speech and the turn-done notification.
 */

export const NEXT_STEPS_PROTOCOL = 'apex-next/1'
const MAX_OPTIONS = 3
const MAX_LABEL_CHARS = 16
const MAX_MESSAGE_CHARS = 300
const MAX_TITLE_CHARS = 20
const DEFAULT_FAILED_TITLE = '刚才那一步'

export interface NextStepOption {
  label: string
  message: string
}

export type NextStepsBlock = { failed: null; options: NextStepOption[] } | { failed: string; options: [] }

export interface ParsedNextSteps {
  block: NextStepsBlock | null
  /** The text with every block (and an unfinished one at the end) taken out. */
  visible: string
}

// No `\b` after the marker: Python's \b treats CJK as word characters and this one does
// not, and both parsers must agree on the same text. Only an ASCII word character glued
// to the marker makes it something else.
const BLOCK_RE = /<!--\s*apex:next(?![A-Za-z0-9_])([\s\S]*?)-->/g
const MARKER = 'apex:next'
// A model that wrapped the block in a code fence leaves an empty fence once the block is gone: drop it too.
const EMPTY_FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n`]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*(?:\n|$)/gm
const FAILED_RE = /^failed\s*=\s*(.*)$/
const LIST_MARKER_RE = /^(?:[-*•]\s+|[0-9０-９]{1,2}\s*[.、)）．]\s*)/

const WRAPPERS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
  ['《', '》'],
  ['`', '`']
]

const charCount = (value: string) => [...value].length

function unwrap(text: string): string {
  const value = text.trim()

  for (const [left, right] of WRAPPERS) {
    if (value.length >= 2 && value.startsWith(left) && value.endsWith(right)) {
      return value.slice(left.length, value.length - right.length).trim()
    }
  }

  return value
}

function splitOption(line: string): NextStepOption | null {
  const cuts = ['|', '｜'].map(separator => line.indexOf(separator)).filter(index => index >= 0)

  if (cuts.length === 0) {
    return null
  }

  const cut = Math.min(...cuts)
  const label = unwrap(line.slice(0, cut).trim().replace(LIST_MARKER_RE, ''))
  const message = unwrap(line.slice(cut + 1))
  const labelChars = charCount(label)
  const messageChars = charCount(message)

  if (labelChars < 1 || labelChars > MAX_LABEL_CHARS || messageChars < 1 || messageChars > MAX_MESSAGE_CHARS) {
    return null
  }

  return { label, message }
}

function parseBody(body: string): NextStepsBlock | null {
  const options: NextStepOption[] = []
  const seen = new Set<string>()

  for (const raw of body.split('\n')) {
    const line = raw.trim()

    if (!line) {
      continue
    }

    const failed = FAILED_RE.exec(line)

    if (failed && !line.includes('|') && !line.includes('｜')) {
      const title = [...unwrap(failed[1])].slice(0, MAX_TITLE_CHARS).join('')

      return { failed: title || DEFAULT_FAILED_TITLE, options: [] }
    }

    const option = splitOption(line)

    if (!option || seen.has(option.label)) {
      continue
    }

    seen.add(option.label)
    options.push(option)

    if (options.length === MAX_OPTIONS) {
      break
    }
  }

  return options.length > 0 ? { failed: null, options } : null
}

/** Cut an unfinished block at the end (`<!-- apex:next` with no `-->`, or half the marker). */
function cutUnterminatedTail(text: string): string {
  const start = text.lastIndexOf('<!--')

  if (start < 0 || text.includes('-->', start)) {
    return text
  }

  const tail = text.slice(start + 4).trim()

  return tail.startsWith(MARKER) || (tail !== '' && MARKER.startsWith(tail)) ? text.slice(0, start) : text
}

export function parseNextSteps(text: string): ParsedNextSteps {
  if (!text || !text.includes('<!--')) {
    return { block: null, visible: text ?? '' }
  }

  let block: NextStepsBlock | null = null

  for (const match of text.matchAll(BLOCK_RE)) {
    block = parseBody(match[1]) ?? block
  }

  const removed = text.replace(BLOCK_RE, '')
  const visible = cutUnterminatedTail(removed === text ? removed : removed.replace(EMPTY_FENCE_RE, ''))

  if (visible === text) {
    return { block: null, visible: text }
  }

  return { block, visible: visible.replace(/\n{3,}/g, '\n\n').trim() }
}

/** The text a reader may see: every block gone. Untouched when there is none. */
export function stripNextStepBlocks(text: string): string {
  return parseNextSteps(text).visible
}

// What a streamed reply may end with while a block is still arriving: "<", "<!", "<!-".
// ("<!--…" is decided by cutUnterminatedTail's rule in openBlockIndex.)
const PARTIAL_OPENER_RE = /<(?:!-?)?$/

function openBlockIndex(text: string): number {
  const start = text.lastIndexOf('<!--')

  if (start >= 0 && !text.includes('-->', start)) {
    const tail = text.slice(start + 4).trimStart()

    if (tail.startsWith(MARKER) || MARKER.startsWith(tail)) {
      return start
    }
  }

  const partial = PARTIAL_OPENER_RE.exec(text)

  return partial ? partial.index : -1
}

export interface NextStepsSpeechFilter {
  /** Text that is safe to speak now; a block that may be starting is held back. */
  push: (delta: string) => string
  /** End of the reply: an unfinished block is dropped, anything else is released. */
  flush: () => string
}

/** Streamed speech hears deltas, not the whole reply, so the block has to be held back as it arrives. */
export function createNextStepsSpeechFilter(): NextStepsSpeechFilter {
  let pending = ''

  return {
    flush: () => {
      const rest = stripNextStepBlocks(pending)
      pending = ''

      return rest
    },
    push: delta => {
      pending = (pending + delta).replace(BLOCK_RE, '')
      const open = openBlockIndex(pending)
      const ready = open < 0 ? pending : pending.slice(0, open)
      pending = open < 0 ? '' : pending.slice(open)

      return ready
    }
  }
}
