import { deliveryTargetFromCommand } from '@/components/assistant-ui/thread/agent-delivery'
import { type DelegateRow, delegateRowsFromCall } from '@/components/assistant-ui/tool/delegate-model'
import {
  formatDurationSeconds,
  isRecord,
  numberValue,
  parseMaybeObject
} from '@/components/assistant-ui/tool/fallback-model/format'
import { runtimeTranslations, translateNow } from '@/i18n'
import { desktopOnlyStepCopy, memoryStepKey } from '@/i18n/desktop-only-steps'
import type { StepCopy, StepFacts } from '@/i18n/types-process'
import { connectorCalls } from '@/lib/connector-tools'
import { isOnboardingEnabled } from '@/lib/onboarding-enabled'
import { skillDisplayName } from '@/lib/skill-display-name'
import { firstStringField } from '@/lib/text'
import { isCardTool, isSilentTool } from '@/lib/tool-render-class'
import { extractToolErrorMessage } from '@/lib/tool-result-summary'

import { plainGroupKey, plainStep } from './plain-steps'

/**
 * hc-973: a turn's tool work, as the steps a creator would describe.
 *
 * The transcript used to show every call as its own row — "Tool Search 2
 * results 9ms", "已加载技能: honesty-verification 87ms" — which is the
 * mechanism, not the work. This folds a whole turn (every assistant bubble
 * between two user messages) into steps: consecutive calls of one tool are one
 * step, and finding tools or loading skills is preparation, not a step. Each
 * step knows what it came back with and where its data came from, so the
 * process area can say 「下载视频 → 识别语音 → 搜同类作品」 and, opened, how each
 * one went.
 *
 * Pure: the renderer feeds it the turn's parts and reads the result.
 */

export interface TurnPart {
  args?: unknown
  completedAt?: number
  isError?: boolean
  result?: unknown
  status?: { type?: string }
  text?: unknown
  timestamp?: number
  toolCallId?: string
  toolName?: string
  type: string
}

export type CallState = 'done' | 'failed' | 'running' | 'stopped'

export interface ProcessCall {
  /** Arguments of the tool that actually ran (the bridge's inner call). */
  args: Record<string, unknown>
  error: string
  id: string
  /** Calls a `tool_call` batch carried, 1 otherwise. */
  inner: number
  part: TurnPart
  seconds?: number
  state: CallState
  /** The tool that actually ran: a reloaded `tool_call` bridge resolves to it. */
  toolName: string
}

export interface StepLink {
  label: string
  url: string
}

export interface StepSources {
  count?: number
  links: StepLink[]
  platform?: string
  queries: string[]
  /** The step's own sentence about where its data came from. */
  sentence?: string
}

export interface ProcessStep {
  calls: ProcessCall[]
  copy: StepCopy
  facts: StepFacts
  failedCalls: number
  /** hc-1066, single-thread product mode only: what the step is for (`step-intent.ts`). */
  intent?: string
  key: string
  /** Finding tools and loading skills that led up to this step: shown only
   *  in developer mode, under the step it prepared. */
  prep: ProcessCall[]
  sources: StepSources
  state: CallState
  /** What a delegation handed out, and how each piece went. */
  subtasks: DelegateRow[]
  toolName: string
}

export type TurnPhase = 'done' | 'failed' | 'running' | 'stopped'

/** What a live turn is doing when no step is in flight. */
export type LiveActivity = 'preparing' | 'step' | 'thinking' | 'writing'

export interface TurnReasoning {
  pending: boolean
  /** When the first thought began and the last one ended, as Unix seconds. */
  span: { end?: number; start?: number }
  /** Summed over blocks that recorded both ends; null when none did (a
   *  reloaded transcript keeps the text, not how long it took). */
  seconds: null | number
  texts: string[]
}

export interface TurnProcess {
  activity: LiveActivity | null
  /** The step in flight, by index into `steps`. */
  current: null | number
  durationS?: number
  /** The step the turn got stuck on, by index into `steps`. */
  failed: null | number
  phase: TurnPhase
  /** Preparation with no step after it (a turn that only loaded skills). */
  prepOnly: ProcessCall[]
  reasoning: TurnReasoning
  /** Display names of the skills the turn loaded; unnamed ones are left out. */
  skills: string[]
  /** When the turn's tool work started and last finished, as Unix seconds. */
  span: { end?: number; start?: number }
  steps: ProcessStep[]
}

// Finding tools and loading skills: how the agent gets ready, never a step.
const PREPARATION_TOOLS = new Set(['skill_view', 'skills_list', 'tool_describe', 'tool_search'])

// Cards that answer for themselves where they stand — a question for the user,
// a consent prompt, a pricing ladder, a note to another assistant. A step for
// them would only repeat the card.
const CONVERSATION_CARDS = new Set(['clarify', 'gen_ladder', 'manage_connections', 'setup_mcp'])

// Steps that usually take minutes: the live line says the user can step away.
const SLOW_TOOLS = new Set([
  'generate_video',
  'live_record_start',
  'media_transcribe',
  'social_batch_status',
  'social_batch_submit',
  'video_generate',
  'xai_video_edit',
  'xai_video_extend'
])

export function isSlowTool(toolName: string): boolean {
  return SLOW_TOOLS.has(toolName)
}

export function isPreparationTool(toolName: string): boolean {
  return PREPARATION_TOOLS.has(toolName)
}

/** A terminal call that delivers a message to another assistant renders as
 *  that notice ("已给 helper 发消息"), so it stays in place like a card. */
function isAgentDelivery(part: TurnPart): boolean {
  if (part.toolName !== 'terminal' || part.isError) {
    return false
  }

  const command = parseMaybeObject(part.args).command

  return typeof command === 'string' && deliveryTargetFromCommand(command) !== null
}

/**
 * How a tool part renders in the transcript: `card` keeps its own surface in
 * place, `silent` draws nothing, `activity` folds into the turn's process
 * block. One rule for the transcript and for the anchor that decides where
 * the block goes, or the two would disagree about which calls it covers.
 */
export function processKind(part: TurnPart): 'activity' | 'card' | 'silent' {
  const toolName = part.toolName ?? ''

  if (isOnboardingEnabled() && connectorCalls(toolName, part.args).length > 0) {
    return 'card'
  }

  if (isCardTool(toolName) || CONVERSATION_CARDS.has(toolName) || isAgentDelivery(part)) {
    return 'card'
  }

  return isSilentTool(toolName) && !part.isError ? 'silent' : 'activity'
}

/**
 * Whether a tool part is one of the turn's steps. Activity is; so are the
 * cards that are work the user asked for — an edit, an image, a delegation —
 * which also keep their own surface in place. Conversation cards, notes to
 * other assistants and silent bookkeeping are not.
 */
function isStepPart(part: TurnPart): boolean {
  const kind = processKind(part)
  const toolName = part.toolName ?? ''

  if (kind === 'card') {
    return isCardTool(toolName) && !CONVERSATION_CARDS.has(toolName) && !connectorCalls(toolName, part.args).length
  }

  return kind === 'activity'
}

function bridgeEntries(args: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(args.calls)) {
    return args.calls.map(entry => parseMaybeObject(entry))
  }

  return typeof args.name === 'string' ? [args] : []
}

/** The tool a call actually ran. A reloaded transcript keeps the `tool_call`
 *  bridge the model called; the live feed already names the tool underneath. */
function resolveCall(part: TurnPart): { args: Record<string, unknown>; inner: number; toolName: string } {
  const args = parseMaybeObject(part.args)
  const toolName = part.toolName ?? ''

  if (toolName !== 'tool_call') {
    return { args, inner: 1, toolName }
  }

  const entries = bridgeEntries(args)
  const names = new Set(entries.map(entry => firstStringField(entry, ['name'])))
  const [name] = names

  if (entries.length === 0 || names.size !== 1 || !name) {
    return { args, inner: Math.max(1, entries.length), toolName }
  }

  return { args: parseMaybeObject(entries[0].arguments), inner: entries.length, toolName: name }
}

function callFailed(part: TurnPart): string {
  const result = parseMaybeObject(part.result)

  // Explicit success beats a stale envelope error, as on the tool rows.
  if (result.success === true || result.ok === true) {
    return ''
  }

  const message = extractToolErrorMessage(part.result)

  if (message) {
    return message
  }

  if (part.isError) {
    return typeof part.result === 'string' ? part.result.trim() : ' '
  }

  if (result.success === false || result.ok === false) {
    return firstStringField(result, ['message', 'reason', 'detail', 'error']) || ' '
  }

  return ''
}

function callSeconds(part: TurnPart, result: Record<string, unknown>): number | undefined {
  const reported = numberValue(result.duration_s)

  if (reported !== null && reported >= 0) {
    return reported
  }

  if (part.timestamp !== undefined && part.completedAt !== undefined && part.completedAt >= part.timestamp) {
    return part.completedAt - part.timestamp
  }

  return undefined
}

export function processCall(part: TurnPart, live: boolean): ProcessCall {
  const { args, inner, toolName } = resolveCall(part)
  const result = parseMaybeObject(part.result)
  const unresolved = part.result === undefined && part.completedAt === undefined
  const error = unresolved ? '' : callFailed(part)

  const state: CallState =
    unresolved && live ? 'running' : part.result === undefined && !part.isError ? 'stopped' : error ? 'failed' : 'done'

  return {
    args,
    error: error.trim(),
    id: part.toolCallId ?? '',
    inner,
    part,
    seconds: state === 'running' ? undefined : callSeconds(part, result),
    state,
    toolName
  }
}

// ── Facts: what a call came back with ───────────────────────────────────────

const ITEM_ARRAY_KEYS = [
  'results',
  'items',
  'posts',
  'videos',
  'aweme_list',
  'comments',
  'creators',
  'users',
  'products',
  'topics',
  'keywords',
  'list',
  'rows',
  'files',
  'matches',
  'images',
  'image_urls',
  'urls',
  'notes',
  'tools'
] as const

const ITEM_COUNT_KEYS = ['count', 'total', 'result_count', 'item_count', 'rows_written', 'row_count'] as const

/** How many things a result holds: the first list it carries, at the top or
 *  one level down (`data`, `result`), else a count field. */
function itemCount(result: unknown): number | undefined {
  const record = parseMaybeObject(result)
  const levels = [record, ...['data', 'result', 'payload'].map(key => record[key]).filter(isRecord)]

  for (const level of levels) {
    for (const key of ITEM_ARRAY_KEYS) {
      if (Array.isArray(level[key])) {
        return (level[key] as unknown[]).length
      }
    }
  }

  if (Array.isArray(record.data)) {
    return record.data.length
  }

  for (const level of levels) {
    for (const key of ITEM_COUNT_KEYS) {
      const value = numberValue(level[key])

      if (value !== null && value >= 0) {
        return Math.round(value)
      }
    }
  }

  return undefined
}

function textLength(value: unknown): number | undefined {
  return typeof value === 'string' && value.trim() ? [...value.trim()].length : undefined
}

function mediaSeconds(result: Record<string, unknown>): number | undefined {
  for (const key of ['duration_seconds', 'audio_duration_seconds', 'video_duration_seconds']) {
    const value = numberValue(result[key])

    if (value !== null && value > 0) {
      return value
    }
  }

  const ms = numberValue(result.duration_ms)

  return ms !== null && ms > 0 ? ms / 1000 : undefined
}

function likeCount(result: Record<string, unknown>): number | undefined {
  const stats = parseMaybeObject(result.stats ?? result.statistics)

  for (const value of [stats.digg_count, stats.like_count, result.digg_count, result.like_count, result.likes]) {
    const n = numberValue(value)

    if (n !== null && n > 0) {
      return n
    }
  }

  return undefined
}

const QUERY_KEYS = ['query', 'keyword', 'keywords', 'keyword_list', 'search_term', 'topic', 'q'] as const

function callQueries(args: Record<string, unknown>): string[] {
  const queries: string[] = []

  for (const key of QUERY_KEYS) {
    const value = args[key]

    if (typeof value === 'string' && value.trim()) {
      queries.push(...(key === 'keyword_list' ? value.split(/[,，]/) : [value]))
    } else if (Array.isArray(value)) {
      queries.push(...value.filter((item): item is string => typeof item === 'string'))
    }
  }

  if (Array.isArray(args.queries)) {
    queries.push(...args.queries.filter((item): item is string => typeof item === 'string'))
  }

  return queries.map(query => query.trim()).filter(Boolean)
}

function platformName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  const platforms = runtimeTranslations().assistant.tool.process.platforms

  return platforms[value.trim().toLowerCase()]
}

const URL_RE = /https?:\/\/[^\s"'<>，。、）)\]]+/g

function urlsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.match(URL_RE) ?? []
  }

  if (Array.isArray(value)) {
    return value.flatMap(urlsIn)
  }

  return []
}

function resultLinks(result: Record<string, unknown>): StepLink[] {
  const links: StepLink[] = []
  const shared = firstStringField(result, ['share_url', 'source_url'])

  if (shared && /^https?:\/\//.test(shared)) {
    links.push({ label: firstStringField(result, ['title']), url: shared })
  }

  // Search-style results: the first few hits, titled, at the top or under `data`.
  const data = parseMaybeObject(result.data)

  const hits = [result.results, result.items, data.results, data.items].find(Array.isArray) ?? []

  for (const hit of hits.slice(0, 5)) {
    const row = parseMaybeObject(hit)
    const url = firstStringField(row, ['url', 'link', 'share_url'])

    if (/^https?:\/\//.test(url)) {
      links.push({ label: firstStringField(row, ['title', 'name', 'desc']), url })
    }
  }

  return links
}

/** Where a call read from. What the result says it read wins — a titled
 *  page — over the raw link it was handed, which is usually the same thing. */
function callLinks(call: ProcessCall): StepLink[] {
  const fromResult = resultLinks(parseMaybeObject(call.part.result))

  if (fromResult.length > 0) {
    return fromResult
  }

  return ['url', 'share_url', 'urls', 'link', 'image_urls', 'creator_url'].flatMap(key =>
    urlsIn(call.args[key]).map(url => ({ label: '', url }))
  )
}

function stepFacts(calls: ProcessCall[]): StepFacts {
  const copy = runtimeTranslations().assistant.tool.process
  const facts: StepFacts = { calls: calls.reduce((sum, call) => sum + call.inner, 0) }
  const settled = calls.filter(call => call.state === 'done')
  const results = settled.map(call => parseMaybeObject(call.part.result))
  const counts = settled.map(call => itemCount(call.part.result)).filter((n): n is number => n !== undefined)

  if (counts.length > 0) {
    const total = counts.reduce((sum, n) => sum + n, 0)

    if (total > 0) {
      facts.count = total
    } else {
      facts.empty = true
    }
  }

  const only = results.length === 1 ? results[0] : undefined
  const seconds = only ? mediaSeconds(only) : undefined

  if (seconds !== undefined) {
    facts.length = wholeSeconds(seconds)
  }

  const likes = only ? likeCount(only) : undefined

  if (likes !== undefined) {
    facts.likes = copy.compactNumber(likes)
  }

  const chars = results.reduce<number | undefined>((sum, result) => {
    const length = textLength(result.transcript) ?? textLength(result.captions) ?? textLength(result.text)

    return length === undefined ? sum : (sum ?? 0) + length
  }, undefined)

  if (chars !== undefined) {
    facts.chars = chars
  }

  if (results.some(result => result.speech === false)) {
    facts.empty = true
  }

  const query = calls.flatMap(call => callQueries(call.args))[0]

  if (query) {
    facts.query = query
  }

  const platform = calls
    .map(call => platformName(call.args.platform) ?? platformName(parseMaybeObject(call.part.result).platform))
    .find(Boolean)

  if (platform) {
    facts.platform = platform
  }

  return facts
}

function stepSources(calls: ProcessCall[], copy: StepCopy, facts: StepFacts): StepSources {
  const seen = new Set<string>()

  const links = calls.flatMap(callLinks).filter(link => {
    if (seen.has(link.url)) {
      return false
    }

    seen.add(link.url)

    return true
  })

  const sources: StepSources = {
    links: links.slice(0, 6),
    queries: [...new Set(calls.flatMap(call => callQueries(call.args)))]
  }

  if (facts.count) {
    sources.count = facts.count
  }

  if (facts.platform) {
    sources.platform = facts.platform
  }

  const sentence = copy.source?.(facts)

  if (sentence) {
    sources.sentence = sentence
  }

  return sources
}

/** Whether a step has anything to say under 「数据从哪来」. */
export function hasSources(sources: StepSources): boolean {
  return Boolean(sources.sentence || sources.links.length || sources.queries.length)
}

export function stepCopyFor(toolName: string): StepCopy {
  const copy = runtimeTranslations().assistant.tool.process

  return copy.steps[toolName] ?? desktopOnlyStepCopy(toolName) ?? copy.unknownStep
}

/** hc-1063 / hc-1097: a memory-ledger step that only forgot, or only looked, is named for that. */
function stepCopyKey(calls: ProcessCall[]): string {
  const toolName = calls[0].toolName

  return toolName === 'apex_memory' ? memoryStepKey(calls.map(call => call.args.action)) : toolName
}

function stepState(calls: ProcessCall[]): { failedCalls: number; state: CallState } {
  const failedCalls = calls.filter(call => call.state === 'failed').length

  if (calls.some(call => call.state === 'running')) {
    return { failedCalls, state: 'running' }
  }

  if (calls.some(call => call.state === 'stopped')) {
    return { failedCalls, state: 'stopped' }
  }

  return { failedCalls, state: failedCalls === calls.length ? 'failed' : 'done' }
}

function buildStep(calls: ProcessCall[], prep: ProcessCall[], plain: boolean): ProcessStep {
  const toolName = calls[0].toolName
  const named = plain ? plainStep(calls) : null
  const copy = named?.copy ?? stepCopyFor(stepCopyKey(calls))
  const facts = stepFacts(calls)
  const { failedCalls, state } = stepState(calls)

  return {
    calls,
    copy,
    facts,
    failedCalls,
    ...(named ? { intent: named.intent } : {}),
    key: calls[0].id || `${toolName}:${calls[0].part.timestamp ?? ''}`,
    prep,
    sources: stepSources(calls, copy, facts),
    state,
    subtasks:
      toolName === 'delegate_task'
        ? calls.flatMap(call => delegateRowsFromCall(call.part.args, call.part.result, call.id))
        : [],
    toolName
  }
}

// How long a thought took is only ever measured by the live stream's stamps. A
// finished turn can be rebuilt from stored history afterwards (reconciliation,
// catch-up hydration), where a thought keeps its text but loses its end stamp
// or gets a later start one — seen on a real turn as 「想了 12 秒」 turning into
// 「想了 1 秒」 at settle. So each thought's longest measured time is kept for
// the app session, keyed by its text, and a rebuilt turn never undercounts what
// the user watched. A thought nobody measured stays unmeasured: 「想过了」.
const measuredThoughts = new Map<string, number>()
const MAX_MEASURED_THOUGHTS = 500

function thoughtSeconds(block: TurnPart, text: string): number | undefined {
  const own =
    block.timestamp !== undefined && block.completedAt !== undefined && block.completedAt >= block.timestamp
      ? block.completedAt - block.timestamp
      : undefined

  const key = `${text.length}:${text.slice(0, 96)}`
  const known = measuredThoughts.get(key)
  const best = own === undefined ? known : Math.max(own, known ?? own)

  if (best !== undefined && best !== known) {
    if (measuredThoughts.size >= MAX_MEASURED_THOUGHTS) {
      measuredThoughts.delete(measuredThoughts.keys().next().value as string)
    }

    measuredThoughts.set(key, best)
  }

  return best
}

export function __resetMeasuredThoughtsForTests() {
  measuredThoughts.clear()
}

function reasoningOf(parts: readonly TurnPart[], live: boolean): TurnReasoning {
  const blocks = parts.filter(part => part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim())
  let seconds: null | number = null

  for (const block of blocks) {
    const measured = thoughtSeconds(block, (block.text as string).trim())

    if (measured !== undefined) {
      seconds = (seconds ?? 0) + measured
    }
  }

  const starts = blocks.map(block => block.timestamp).filter((n): n is number => n !== undefined)
  const ends = blocks.map(block => block.completedAt).filter((n): n is number => n !== undefined)

  return {
    pending: live && blocks.some(block => block.completedAt === undefined && block.status?.type !== 'complete'),
    seconds,
    span: {
      end: ends.length > 0 ? Math.max(...ends) : undefined,
      start: starts.length > 0 ? Math.min(...starts) : undefined
    },
    texts: blocks.map(block => (block.text as string).trim())
  }
}

function turnSeconds(parts: readonly TurnPart[]): number | undefined {
  let start: number | undefined
  let end: number | undefined

  for (const part of parts) {
    if (part.timestamp !== undefined) {
      start = start === undefined ? part.timestamp : Math.min(start, part.timestamp)
    }

    if (part.completedAt !== undefined) {
      end = end === undefined ? part.completedAt : Math.max(end, part.completedAt)
    }
  }

  return start !== undefined && end !== undefined && end > start ? end - start : undefined
}

function liveActivity(parts: readonly TurnPart[], steps: ProcessStep[], prepOnly: ProcessCall[]): LiveActivity {
  if (steps.some(step => step.state === 'running')) {
    return 'step'
  }

  const tail = parts.at(-1)

  if (tail?.type === 'reasoning') {
    return 'thinking'
  }

  if (tail?.type === 'tool-call' && isPreparationTool(resolveCall(tail).toolName)) {
    return 'preparing'
  }

  if (tail?.type === 'text' && steps.length > 0) {
    return 'writing'
  }

  return steps.length === 0 && prepOnly.length > 0 ? 'preparing' : 'thinking'
}

export interface TurnSteps {
  prepOnly: ProcessCall[]
  skills: string[]
  steps: ProcessStep[]
}

/**
 * The turn's calls, folded into steps (see `buildTurnProcess`). `plain`
 * (hc-1066, single-thread product mode) folds and names them by what they are
 * for — 「抽帧」「合成视频」 — instead of by tool.
 */
export function buildTurnSteps(parts: readonly TurnPart[], live: boolean, plain = false): TurnSteps {
  const steps: ProcessStep[] = []
  const skills: string[] = []
  let pendingPrep: ProcessCall[] = []
  let group: ProcessCall[] = []
  const groupKey = (call: ProcessCall) => (plain ? plainGroupKey(call) : call.toolName)

  const flush = () => {
    if (group.length > 0) {
      steps.push(buildStep(group, pendingPrep, plain))
      pendingPrep = []
      group = []
    }
  }

  // A call left without a result once the agent has written or thought past
  // it is not running: the agent moved on (the turn was stopped, or its
  // completion event was lost), so it reads as settled.
  const lastProse = parts.findLastIndex(part => part.type === 'text' || part.type === 'reasoning')

  for (const [index, part] of parts.entries()) {
    if (part.type !== 'tool-call' || !isStepPart(part)) {
      continue
    }

    const call = processCall(part, live && index > lastProse)

    if (isPreparationTool(call.toolName)) {
      if (call.toolName === 'skill_view') {
        const name = firstStringField(call.args, ['name'])
        const display = name ? skillDisplayName(name) : ''

        if (display && !skills.includes(display)) {
          skills.push(display)
        }
      }

      flush()
      pendingPrep.push(call)

      continue
    }

    if (group.length > 0 && groupKey(group[0]) !== groupKey(call)) {
      flush()
    }

    group.push(call)
  }

  flush()

  // Preparation after the last step belongs to it; with no step at all it is
  // all the turn did.
  let prepOnly: ProcessCall[] = []

  if (pendingPrep.length > 0) {
    if (steps.length > 0) {
      steps[steps.length - 1].prep = [...steps[steps.length - 1].prep, ...pendingPrep]
    } else {
      prepOnly = pendingPrep
    }
  }

  return { prepOnly, skills, steps }
}

/**
 * Fold a turn's parts into its steps.
 *
 * `live` is whether the turn is still working; `durationS` the turn's own
 * wall-clock duration when the stream recorded one. `prebuilt` lets a caller
 * that already folded the calls (they change far less often than the
 * reasoning streams) skip doing it again.
 */
export function buildTurnProcess(
  parts: readonly TurnPart[],
  live: boolean,
  durationS?: number,
  prebuilt: TurnSteps = buildTurnSteps(parts, live)
): TurnProcess {
  const { prepOnly, skills, steps } = prebuilt
  const reasoning = reasoningOf(parts, live)
  // Parallel calls can leave more than one step running; the newest is the
  // one the line names.
  const current = live ? steps.findLastIndex(step => step.state === 'running') : -1

  // Stuck: the turn settled and its last step never came good.
  const last = steps.length - 1
  const lastState = last >= 0 ? steps[last].state : 'done'

  const phase: TurnPhase = live
    ? 'running'
    : lastState === 'failed'
      ? 'failed'
      : lastState === 'stopped'
        ? 'stopped'
        : 'done'

  return {
    activity: live ? liveActivity(parts, steps, prepOnly) : null,
    current: current >= 0 ? current : null,
    durationS: live ? undefined : (durationS ?? turnSeconds(parts)),
    failed: phase === 'failed' || phase === 'stopped' ? last : null,
    phase,
    prepOnly,
    reasoning,
    skills,
    span: toolSpan(steps, prepOnly),
    steps
  }
}

function toolSpan(steps: readonly ProcessStep[], prepOnly: readonly ProcessCall[]): TurnProcess['span'] {
  const calls = [...prepOnly, ...steps.flatMap(step => [...step.prep, ...step.calls])]
  const starts = calls.map(call => call.part.timestamp).filter((n): n is number => n !== undefined)
  const ends = calls.map(call => call.part.completedAt).filter((n): n is number => n !== undefined)

  return {
    end: ends.length > 0 ? Math.max(...ends) : undefined,
    start: starts.length > 0 ? Math.min(...starts) : undefined
  }
}

/** Whether a turn has anything for the process block to say. */
export function turnHasProcess(process: TurnProcess): boolean {
  return process.steps.length > 0 || process.prepOnly.length > 0
}

/** The finished chain: 「下载视频 → 识别语音 → 搜同类作品」, long ones cut short. */
export function stepChain(
  steps: readonly ProcessStep[],
  separator: string,
  moreSteps: (total: number) => string
): string {
  const titles = steps.map(step => step.copy.title)

  if (titles.length <= 4) {
    return titles.join(separator)
  }

  return [...titles.slice(0, 3), '…', titles.at(-1)].join(separator) + ` ${moreSteps(titles.length)}`
}

/**
 * A duration in whole seconds, in the locale's words: 「8 秒」, 「2 分 10 秒」.
 * Under a second it says nothing — a millisecond count is the mechanism's
 * number, not the user's.
 */
export function wholeSeconds(seconds: null | number | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 1) {
    return ''
  }

  const whole = Math.round(seconds)

  return whole < 60 ? translateNow('assistant.tool.formatDuration', String(whole), 's') : formatDurationSeconds(whole)
}

/** How long one call took, the way the developer line shows it. */
export function callDuration(call: ProcessCall): string {
  return call.seconds === undefined ? '' : formatDurationSeconds(call.seconds)
}
