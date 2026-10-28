/**
 * hc-1086 with hc-1088 (多助手二期 R1 / R3): Desktop's side of
 * `apps/desktop/shared/apex-handoff-cases.json`. The engine's tests
 * (tests/apex_overlay/test_handoff_cases.py) read the same cases:
 *
 * - request: the hand-over message the relay runner submits;
 * - request_header: how the runner finds that message again in the thread;
 * - handback: the 交回摘要 read out of the receiver's reply, and the reply without it.
 *
 * `division` and `roster` are hc-1088's (handoff-division-roster.test.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  composeHandoffRequest,
  HANDBACK_HEAD_MAX_CHARS,
  HANDBACK_ITEMS_MAX,
  HANDBACK_SUMMARY_MAX_CHARS,
  HANDOFF_ITEMS_MAX,
  HANDOFF_PROTOCOL,
  HANDOFF_RESULT_MAX_CHARS,
  type HandoffRequestInput,
  parseHandback,
  parseHandoffHeader
} from '@/lib/handoff-text'

interface Cases {
  protocol: string
  request: {
    cases: { about: string; input: Omit<HandoffRequestInput, 'fromName'> & { from_name: string }; text: string }[]
    items_max: number
    result_max_chars: number
  }
  request_header: { cases: { request: { from: string; id: string } | null; text: string }[] }
  handback: {
    cases: {
      about: string
      block: { files: string[]; links: string[]; summary: string } | null
      reply: string
      visible: string
    }[]
    items_max: number
    summary_max_chars: number
  }
  return_box: { head_max_chars: number }
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'shared', 'apex-handoff-cases.json'), 'utf8')
) as Cases

describe('apex-handoff-cases.json, as Desktop reads it', () => {
  it('speaks the same protocol and limits', () => {
    expect(CASES.protocol).toBe(HANDOFF_PROTOCOL)
    expect(CASES.request.result_max_chars).toBe(HANDOFF_RESULT_MAX_CHARS)
    expect(CASES.request.items_max).toBe(HANDOFF_ITEMS_MAX)
    expect(CASES.handback.summary_max_chars).toBe(HANDBACK_SUMMARY_MAX_CHARS)
    expect(CASES.handback.items_max).toBe(HANDBACK_ITEMS_MAX)
    expect(CASES.return_box.head_max_chars).toBe(HANDBACK_HEAD_MAX_CHARS)
  })

  it.each(CASES.request.cases.map(c => [c.about, c] as const))('request: %s', (_about, c) => {
    const { from_name: fromName, ...rest } = c.input
    const text = composeHandoffRequest({ ...rest, fromName })

    expect(text).toBe(c.text)
    // The runner finds its own message again by the header it wrote.
    expect(parseHandoffHeader(text)).toEqual({ from: c.input.from, id: c.input.id })
  })

  it.each(CASES.request_header.cases.map(c => [JSON.stringify(c.text), c] as const))(
    'request_header: %s',
    (_text, c) => {
      expect(parseHandoffHeader(c.text)).toEqual(c.request)
    }
  )

  it.each(CASES.handback.cases.map(c => [c.about, c] as const))('handback: %s', (_about, c) => {
    expect(parseHandback(c.reply)).toEqual({ block: c.block, visible: c.visible })
  })
})

describe('beyond the cases: the same reading as the engine (apex_overlay/handoff.py)', () => {
  it('cuts a long summary, drops the whitespace before the ellipsis', () => {
    const summary = `${'很'.repeat(HANDBACK_SUMMARY_MAX_CHARS - 1)} 后面`
    const block = parseHandback(`好\n<!-- apex:handback\n${summary}\n-->`).block

    expect(block?.summary).toBe(`${'很'.repeat(HANDBACK_SUMMARY_MAX_CHARS - 1)}…`)
  })

  it('reads file and link keys in any case', () => {
    expect(
      parseHandback('好\n<!-- apex:handback\n摘要\n- files: /Users/me/a.png\nLINK：https://x.test\n-->').block
    ).toEqual({
      files: ['/Users/me/a.png'],
      links: ['https://x.test'],
      summary: '摘要'
    })
  })

  it('takes only lowercase letters as a header key', () => {
    expect(parseHandoffHeader('<!-- apex:handoff v=1 id=h1 from=default Round=2 -->')).toBeNull()
    expect(parseHandoffHeader('<!-- apex:handoff v=1 id=h1 from=default round_2=x -->')).toBeNull()
  })
})
