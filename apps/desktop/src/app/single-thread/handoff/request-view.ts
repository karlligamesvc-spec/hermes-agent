/**
 * hc-1087: what a hand-over message (R3's `request`, lib/handoff-text.ts)
 * says, read back for 「X 交来的活」 in the receiver's thread when this install
 * has no record of the relay (records are trimmed; the engine keeps the
 * message). The record, when there is one, is read instead.
 */

import { HANDOFF_RESULT_MAX_CHARS } from '@/lib/handoff-text'
import { withoutHandoffHeader } from '@/lib/reply-markers'
import type { HandoffRecord } from '@/store/single-thread-handoff'

export interface HandoffRequestView {
  fromName: string
  ask: string
  /** The previous result as carried; '' when none went along. */
  previous: string
  truncated: boolean
  /** Files first, then links. */
  items: string[]
}

const TITLE_RE = /^【(.+) 交来的活】$/
const ASK_HEAD = '要你做：\n'
const PREVIOUS_RE = /^(.+) 上一条结果(（前 2,000 字，后面没带）)?：\n/
const ITEMS_HEAD = '里面的文件和链接：\n'

function unquoted(block: string): string {
  return block
    .split('\n')
    .map(line => (line === '>' ? '' : line.replace(/^> ?/, '')))
    .join('\n')
}

/** The parts of a hand-over message; null when it is not one Desktop composed. */
export function parseHandoffRequest(text: string): HandoffRequestView | null {
  const blocks = withoutHandoffHeader(text.replace(/\r\n?/g, '\n')).trim().split('\n\n')
  const title = TITLE_RE.exec(blocks[0]?.trim() ?? '')

  if (!title) {
    return null
  }

  const view: HandoffRequestView = { ask: '', fromName: title[1]!, items: [], previous: '', truncated: false }

  for (const block of blocks.slice(1)) {
    const previous = PREVIOUS_RE.exec(block)

    if (block.startsWith(ASK_HEAD)) {
      view.ask = unquoted(block.slice(ASK_HEAD.length))
    } else if (previous) {
      view.previous = unquoted(block.slice(previous[0].length))
      view.truncated = Boolean(previous[2])
    } else if (block.startsWith(ITEMS_HEAD)) {
      view.items = block
        .slice(ITEMS_HEAD.length)
        .split('\n')
        .map(line => line.replace(/^- /, '').trim())
        .filter(Boolean)
    }
  }

  return view
}

/** The same view from this install's record of the relay. */
export function requestViewFromRecord(record: HandoffRecord): HandoffRequestView {
  return {
    ask: record.ask,
    fromName: record.from.name || record.from.profile,
    items: [...record.carry.files, ...record.carry.links],
    previous: record.carry.text,
    truncated: record.carry.truncated || [...record.carry.text].length > HANDOFF_RESULT_MAX_CHARS
  }
}
