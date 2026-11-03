/**
 * hc-1091 多助手二期 R6: the relay plan (一条龙接力) block. When the user wants
 * several assistants to carry one job through (「选题、标题、成片一条龙做完」),
 * APEX ends its reply with
 *
 *   <!-- apex:plan
 *   已有 | 定选题：租房党衣柜改造，不打孔
 *   @小红书文案 | 写标题和文案 | 按这个选题写 3 个标题和一段 200 字文案
 *   @剪辑助手 | 剪成 30 秒竖屏 | 用小红书文案交回的标题和文案，把素材剪成 30 秒竖屏
 *   -->
 *
 * and Desktop draws a plan card the user starts (L2). Desktop's own marker,
 * like hc-1088's apex:handoff and apex:handback: not part of the 「下一步」
 * protocol (apex-next/1), so apex-nodes and the cloud never see it. The
 * engine's prompt rule (apex_overlay/handoff.py `PLAN_RULE`) and this reader
 * share `apps/desktop/shared/apex-handoff-plan-cases.json`.
 *
 * - One baton a line, at most {@link HANDOFF_PLAN_MAX_LEGS} (L3), 「已有」 counted.
 * - 「已有 | …」, first line only: the planner's own part, already done in this
 *   reply or before it. It runs no turn.
 * - Every other line is a 「交给」 item (hc-1089's syntax, lib/next-steps.ts
 *   `parseHandoffLine`): the assistant, what this baton does (the card's line),
 *   what it is asked.
 * - The last usable block counts; an unfinished one at the end and a code
 *   fence left empty go, as for apex:handback. Lines that read as neither are
 *   skipped.
 */

import { parseHandoffLine } from '@/lib/next-steps'

export const HANDOFF_PLAN_PROTOCOL = 'apex-plan/1'

/** Batons in one plan, 「已有」 included (L3). */
export const HANDOFF_PLAN_MAX_LEGS = 3

/** Lines read from one block: an over-long plan is still shown (and not started), up to this many. */
const MAX_READ_LEGS = 6

const HAVE_MAX_CHARS = 40

export type HandoffPlanLeg = { kind: 'have'; label: string } | { kind: 'relay'; to: string; label: string; ask: string }

export interface HandoffPlanBlock {
  legs: HandoffPlanLeg[]
  /** More batons than {@link HANDOFF_PLAN_MAX_LEGS} were written: shown, never started. */
  overCap: boolean
}

export interface ParsedHandoffPlan {
  /** The last usable block, or null. */
  block: HandoffPlanBlock | null
  /** The text with every block (and an unfinished one at the end) taken out; untouched when there is none. */
  visible: string
}

const PLAN_MARKER = 'apex:plan'
export const PLAN_BLOCK_RE = /<!--\s*apex:plan(?![A-Za-z0-9_])([\s\S]*?)-->/g
const EMPTY_FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n`]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*(?:\n|$)/gm
const LIST_MARKER_RE = /^(?:[-*•]\s+|[0-9０-９]{1,2}\s*[.、)）．]\s*)/
const HAVE_RE = /^(?:已有|done)\s*[|｜]\s*(.*)$/i

const WRAPPERS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
  ['《', '》'],
  ['`', '`']
]

function unwrap(text: string): string {
  const value = text.trim()

  for (const [left, right] of WRAPPERS) {
    if (value.length >= 2 && value.startsWith(left) && value.endsWith(right)) {
      return value.slice(left.length, value.length - right.length).trim()
    }
  }

  return value
}

function haveLabel(line: string): null | string {
  const have = HAVE_RE.exec(line.replace(LIST_MARKER_RE, ''))

  if (!have) {
    return null
  }

  const label = unwrap(have[1])
  const chars = [...label].length

  return chars >= 1 && chars <= HAVE_MAX_CHARS ? label : null
}

function planBody(body: string): HandoffPlanBlock | null {
  const legs: HandoffPlanLeg[] = []

  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()

    if (!line) {
      continue
    }

    const have = haveLabel(line)

    if (have !== null) {
      // 「已有」 is the first baton or nothing.
      if (!legs.length) {
        legs.push({ kind: 'have', label: have })
      }

      continue
    }

    const relay = parseHandoffLine(line)

    if (relay) {
      legs.push({ ask: relay.message, kind: 'relay', label: relay.label, to: relay.to })
    }

    if (legs.length === MAX_READ_LEGS) {
      break
    }
  }

  return legs.some(leg => leg.kind === 'relay') ? { legs, overCap: legs.length > HANDOFF_PLAN_MAX_LEGS } : null
}

/** Cut an unfinished block at the end (`<!-- apex:plan` with no `-->`, or half the marker). */
function cutUnfinishedTail(text: string): string {
  const start = text.lastIndexOf('<!--')

  if (start < 0 || text.includes('-->', start)) {
    return text
  }

  const tail = text.slice(start + 4).trim()

  return tail.startsWith(PLAN_MARKER) || (tail !== '' && PLAN_MARKER.startsWith(tail)) ? text.slice(0, start) : text
}

export function parseHandoffPlan(text: null | string | undefined): ParsedHandoffPlan {
  const source = String(text ?? '')

  if (!source.includes('<!--')) {
    return { block: null, visible: source }
  }

  let block: HandoffPlanBlock | null = null

  for (const match of source.matchAll(PLAN_BLOCK_RE)) {
    block = planBody(match[1]) ?? block
  }

  const removed = source.replace(PLAN_BLOCK_RE, '')
  const visible = cutUnfinishedTail(removed === source ? removed : removed.replace(EMPTY_FENCE_RE, ''))

  return visible === source
    ? { block: null, visible: source }
    : { block, visible: visible.replace(/\n{3,}/g, '\n\n').trim() }
}

/** The text without any plan block. Untouched when there is none. */
export function stripPlanBlocks(text: string): string {
  return parseHandoffPlan(text).visible
}

/** Whether a streamed tail may be the start of a plan block (`<!-- apex:plan` with no end yet, or part of the marker). */
export function isOpenPlanTail(tail: string): boolean {
  const rest = tail.trimStart()

  return rest.startsWith(PLAN_MARKER) || PLAN_MARKER.startsWith(rest)
}

/** The relay batons of a plan, in order. */
export function relayLegs(legs: readonly HandoffPlanLeg[]): Extract<HandoffPlanLeg, { kind: 'relay' }>[] {
  return legs.filter((leg): leg is Extract<HandoffPlanLeg, { kind: 'relay' }> => leg.kind === 'relay')
}
