'use client'

import { useStore } from '@nanostores/react'
import { type ComponentProps, type FC } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { TimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { APPROVAL_TOOLS, PendingToolApproval } from '@/components/assistant-ui/tool/approval'
import { ToolEntry } from '@/components/assistant-ui/tool/fallback'
import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'
import { formatDurationSeconds } from '@/components/assistant-ui/tool/fallback-model/format'
import { SCAFFOLD_GLYPH_CLASS, SCAFFOLD_META_CLASS } from '@/components/chat/scaffold-row'
import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'
import type { ProcessCopy } from '@/i18n/types-process'
import { hostPathLabel, PrettyLink } from '@/lib/external-link'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { separateGluedReasoningBlocks } from '@/lib/reasoning-blocks'
import { cn } from '@/lib/utils'
import { $gatewayState } from '@/store/session'
import { $toolDisclosureOpen, $toolViewMode, setToolDisclosureOpen } from '@/store/tool-view'

import { CreatorTipSlot } from './creator-tip'
import {
  type CallState,
  hasSources,
  type ProcessCall,
  processKind,
  type ProcessStep,
  stepChain,
  type TurnProcess,
  wholeSeconds
} from './turn-process'
import { type TurnView, useTurnView } from './turn-state'

/**
 * hc-973: a turn's tool work as one line a creator can read.
 *
 * Live, the line names the step in progress — 「正在识别语音… 第 2 步」. Done, it
 * is the chain of what was done and how long it took, with 「看步骤」 opening
 * the plain-language steps: what each came back with, and on request where its
 * data came from. Reasoning folds to 「想了 8 秒」. Tool code names, timings,
 * raw arguments and output appear only in developer mode, under each step's
 * technical details. A turn that got stuck says on which step and offers to
 * retry, to try another way, or to hand over what it has — as messages the
 * user sends, through the normal composer.
 */

const LINE_CLASS =
  'text-[length:var(--conversation-tool-font-size)] leading-(--conversation-line-height) text-(--ui-text-secondary)'

const NOTE_CLASS =
  'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

const LINK_BUTTON_CLASS =
  'shrink-0 rounded-sm bg-transparent px-0.5 text-[length:var(--conversation-caption-font-size)] text-(--ui-accent-secondary,var(--ui-text-secondary)) underline-offset-2 transition-colors hover:text-(--ui-text-primary) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'

function useDisclosure(id: string, fallback: boolean): [boolean, () => void] {
  const persisted = useStore($toolDisclosureOpen(id))
  const open = persisted ?? fallback

  return [open, () => setToolDisclosureOpen(id, !open)]
}

function StateGlyph({ state }: { state: CallState }) {
  const { t } = useI18n()
  const copy = t.assistant.tool

  if (state === 'running') {
    return (
      <GlyphSpinner
        ariaLabel={copy.statusRunning}
        className="size-3.5 shrink-0 text-[0.95rem] text-(--ui-text-tertiary)"
        spinner="breathe"
      />
    )
  }

  if (state === 'failed') {
    return <AlertCircle aria-label={copy.statusError} className="size-3.5 shrink-0 text-destructive" />
  }

  if (state === 'stopped') {
    return (
      <AlertCircle
        aria-label={copy.process.stepStopped}
        className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
      />
    )
  }

  return (
    <CheckCircle2
      aria-label={copy.statusDone}
      className="size-3.5 shrink-0 text-emerald-600/85 dark:text-emerald-400/85"
    />
  )
}

function stepResult(step: ProcessStep, copy: ProcessCopy): string {
  if (step.state === 'failed') {
    return copy.stepFailed
  }

  if (step.state === 'stopped') {
    return copy.stepStopped
  }

  const done = step.copy.done(step.facts)

  return step.failedCalls > 0 ? `${done} · ${copy.stepPartlyFailed(step.failedCalls)}` : done
}

interface StatusLine {
  meta: string[]
  state: CallState
  text: string
}

function statusLine(process: TurnProcess, copy: ProcessCopy): StatusLine {
  const { steps } = process
  const status = copy.status

  if (process.phase === 'running') {
    const current = process.current === null ? null : steps[process.current]

    if (process.activity === 'step' && current) {
      return {
        meta: [status.stepOf((process.current ?? 0) + 1)],
        state: 'running',
        text: status.running(current.copy.running)
      }
    }

    const text =
      process.activity === 'preparing'
        ? status.preparing
        : process.activity === 'writing'
          ? status.writing
          : status.thinking

    return { meta: [], state: 'running', text }
  }

  const stuck = process.failed === null ? null : steps[process.failed]

  if (stuck && (process.phase === 'failed' || process.phase === 'stopped')) {
    return {
      meta: [status.stepOfTotal((process.failed ?? 0) + 1, steps.length)],
      state: process.phase === 'failed' ? 'failed' : 'stopped',
      text: process.phase === 'failed' ? status.failed(stuck.copy.title) : status.stopped(stuck.copy.title)
    }
  }

  const took = wholeSeconds(process.durationS)

  if (steps.length === 0) {
    return { meta: [], state: 'done', text: status.methodsOnly(process.skills.join(copy.listSeparator)) }
  }

  return {
    meta: took ? [status.took(took)] : [],
    state: 'done',
    text: stepChain(steps, status.chainSeparator, status.moreSteps)
  }
}

/** Show what a step said went wrong only when it is in the user's language
 *  and names no code; otherwise a plain stand-in. */
function readableReason(error: string, copy: ProcessCopy, locale: string): string {
  const text = error.trim()
  const chinese = locale.startsWith('zh')

  const readable = chinese
    ? /[一-鿿]/.test(text) && !/[A-Za-z]{3,}/.test(text)
    : text.length > 0 && !/[一-鿿]/.test(text) && !/\b[a-z]+_[a-z_]+\b/.test(text)

  if (!readable) {
    return copy.failure.fallbackReason
  }

  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

function SourcesPanel({ step }: { step: ProcessStep }) {
  const { t } = useI18n()
  const copy = t.assistant.tool.process
  const { sources } = step

  return (
    <div
      className={cn(
        NOTE_CLASS,
        'ms-5 grid gap-1 rounded-md bg-(--ui-bg-quinary) px-2.5 py-1.5 text-(--ui-text-secondary)'
      )}
      data-process-sources=""
    >
      {sources.sentence ? (
        <p className="m-0">{sources.sentence}</p>
      ) : (
        sources.platform && <p className="m-0">{copy.source.platform(sources.platform)}</p>
      )}
      {sources.queries.length > 0 && (
        <p className="m-0 flex min-w-0 flex-wrap gap-x-2">
          <span className="text-(--ui-text-tertiary)">{copy.source.queries}</span>
          <span className="min-w-0 wrap-anywhere">{sources.queries.join(copy.listSeparator)}</span>
        </p>
      )}
      {sources.count !== undefined && <p className="m-0">{copy.source.count(sources.count)}</p>}
      {sources.links.length > 0 && (
        <div className="grid min-w-0 gap-0.5">
          <span className="text-(--ui-text-tertiary)">{copy.source.links}</span>
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {sources.links.map(link => (
              <li className="min-w-0" data-process-link="" key={link.url}>
                <PrettyLink
                  className="block max-w-full truncate"
                  fallbackLabel={hostPathLabel(link.url)}
                  href={link.url}
                  label={link.label || undefined}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Subtasks({ step }: { step: ProcessStep }) {
  const { t } = useI18n()
  const copy = t.assistant.tool.process.subtasks

  const label = (status: string) =>
    status === 'completed'
      ? copy.done
      : status === 'failed' || status === 'interrupted'
        ? copy.failed
        : status === 'dispatched'
          ? copy.dispatched
          : copy.running

  return (
    <div className="ms-5 grid gap-1 border-s border-(--ui-stroke-tertiary) ps-2.5" data-process-subtasks="">
      <span className={NOTE_CLASS}>{copy.title}</span>
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {step.subtasks.map(row => (
          <li className={cn(NOTE_CLASS, 'flex min-w-0 gap-2 text-(--ui-text-secondary)')} key={row.id}>
            <span className="min-w-0 flex-1 truncate">{row.goal}</span>
            <span className="shrink-0 text-(--ui-text-tertiary)">{label(row.status)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Developer mode: code names, timings and each call's own row (arguments,
 *  output, commands), under the step they belong to. */
function TechDetails({ calls }: { calls: readonly ProcessCall[] }) {
  const { t } = useI18n()
  const copy = t.assistant.tool.process.tech
  const names = [...new Set(calls.map(call => call.toolName))].join(', ')
  const seconds = calls.reduce((sum, call) => sum + (call.seconds ?? 0), 0)
  const duration = calls.some(call => call.seconds !== undefined) ? formatDurationSeconds(seconds) : ''
  const rows = calls.filter(call => processKind(call.part) === 'activity')

  return (
    <div className="ms-5 grid min-w-0 gap-1" data-process-tech="">
      <p className="m-0 font-mono text-[0.65rem] leading-relaxed text-(--ui-text-tertiary)">
        {copy.title} · {copy.line(names, duration)}
        {calls.length > 1 && ` · ${copy.calls(calls.length)}`}
      </p>
      {rows.length > 0 && (
        <div className="grid min-w-0 gap-(--tool-row-gap)">
          {rows.map(call => (
            <ToolEntry key={call.id || call.toolName} part={call.part as ToolPart} />
          ))}
        </div>
      )}
    </div>
  )
}

function StepRow({
  devMode,
  index,
  step,
  turnKey
}: {
  devMode: boolean
  index: number
  step: ProcessStep
  turnKey: string
}) {
  const { t } = useI18n()
  const copy = t.assistant.tool.process
  const showSources = step.state !== 'running' && hasSources(step.sources)
  const [sourcesOpen, toggleSources] = useDisclosure(`process-source:${turnKey}:${step.key}`, false)
  const running = step.state === 'running'

  return (
    <li className="grid min-w-0 gap-1" data-process-step="" data-state={step.state}>
      <div className={cn(LINE_CLASS, 'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5')}>
        <span className={cn(SCAFFOLD_GLYPH_CLASS, 'self-center')}>
          <StateGlyph state={step.state} />
        </span>
        <span className={cn('font-medium text-(--ui-text-primary)', running && 'shimmer')}>
          {running ? copy.status.running(step.copy.running) : step.copy.title}
        </span>
        {!running && <span className="text-(--ui-text-tertiary)">{stepResult(step, copy)}</span>}
        {showSources && (
          <button
            aria-expanded={sourcesOpen}
            className={LINK_BUTTON_CLASS}
            data-process-source-toggle=""
            onClick={toggleSources}
            type="button"
          >
            {sourcesOpen ? copy.hideSource : copy.showSource}
          </button>
        )}
      </div>
      {sourcesOpen && showSources && <SourcesPanel step={step} />}
      {step.subtasks.length > 0 && <Subtasks step={step} />}
      {devMode && <TechDetails calls={[...step.prep, ...step.calls]} />}
      <span className="sr-only">{copy.status.stepOf(index + 1)}</span>
    </li>
  )
}

function StepsList({ devMode, process, turnKey }: { devMode: boolean; process: TurnProcess; turnKey: string }) {
  const { t } = useI18n()
  const copy = t.assistant.tool.process

  return (
    <div className="grid min-w-0 gap-1.5 border-s-2 border-(--ui-stroke-tertiary) ps-3" data-process-steps="">
      <ol aria-label={copy.stepsLabel} className="m-0 grid list-none gap-1.5 p-0">
        {process.steps.map((step, index) => (
          <StepRow devMode={devMode} index={index} key={step.key} step={step} turnKey={turnKey} />
        ))}
      </ol>
      {devMode && process.prepOnly.length > 0 && <TechDetails calls={process.prepOnly} />}
      {process.skills.length > 0 && (
        <p className={cn(NOTE_CLASS, 'm-0')}>{copy.methods(process.skills.join(copy.listSeparator))}</p>
      )}
    </div>
  )
}

function FailureCard({ process, view }: { process: TurnProcess; view: TurnView }) {
  const { locale, t } = useI18n()
  const copy = t.assistant.tool.process
  const gatewayState = useStore($gatewayState)
  const step = process.failed === null ? null : process.steps[process.failed]

  if (!step) {
    return null
  }

  const failedCall = step.calls.findLast(call => call.state === 'failed')
  const title = step.copy.title
  const canAsk = view.isLastTurn && !view.live && gatewayState === 'open'

  const ask = (message: string) => {
    requestComposerSubmit(message)
  }

  return (
    <div
      className="grid gap-2 rounded-lg border border-[color-mix(in_srgb,var(--dt-destructive)_28%,transparent)] bg-[color-mix(in_srgb,var(--dt-destructive)_5%,transparent)] px-3 py-2.5"
      data-process-failure=""
      role="alert"
    >
      <p className={cn(LINE_CLASS, 'm-0 flex flex-wrap gap-x-1 text-(--ui-text-primary)')}>
        <span>{readableReason(failedCall?.error ?? '', copy, locale)}</span>
        <span>{copy.failure.keptNote}</span>
      </p>
      {view.isLastTurn && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canAsk} onClick={() => ask(copy.failure.retryMessage(title))} size="sm" type="button">
            {copy.failure.retry}
          </Button>
          <Button
            disabled={!canAsk}
            onClick={() => ask(copy.failure.anotherWayMessage(title))}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.failure.anotherWay}
          </Button>
          <Button
            disabled={!canAsk}
            onClick={() => ask(copy.failure.partialMessage(title))}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.failure.partial}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The folded reasoning chip, shared with the thought of a turn that used no
 *  tools (thread/message-parts `ThinkingDisclosure`). */
export const REASONING_CHIP_CLASS = cn(
  NOTE_CLASS,
  'inline-flex max-w-fit items-center gap-1 rounded-full border border-(--ui-stroke-tertiary) bg-transparent px-2.5 py-0.5 transition-colors hover:text-(--ui-text-secondary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
)

export const REASONING_BODY_CLASS = 'grid min-w-0 gap-1.5 rounded-lg bg-(--ui-bg-quinary) px-3 py-2'

/** 「正在想」 while it streams, 「想了 8 秒」 once a duration is known, else 「想过了」. */
export function reasoningLabel(copy: ProcessCopy['reasoning'], pending: boolean, seconds: null | number): string {
  if (pending) {
    return copy.thinking
  }

  const took = wholeSeconds(seconds)

  return took ? copy.thoughtFor(took) : copy.thought
}

function ReasoningChip({ process, turnKey }: { process: TurnProcess; turnKey: string }) {
  const { t } = useI18n()
  const [open, toggle] = useDisclosure(`process-reasoning:${turnKey}`, false)
  const { reasoning } = process

  if (reasoning.texts.length === 0) {
    return null
  }

  return (
    <div className="grid min-w-0 gap-1" data-process-reasoning="">
      <span className="flex min-w-0 items-center gap-1.5">
        <button aria-expanded={open} className={REASONING_CHIP_CLASS} onClick={toggle} type="button">
          <span className={cn(reasoning.pending && 'shimmer')}>
            {reasoningLabel(t.assistant.tool.process.reasoning, reasoning.pending, reasoning.seconds)}
          </span>
          <DisclosureCaret open={open} size="0.625rem" />
        </button>
        <TimelineTimestamp
          className={SCAFFOLD_META_CLASS}
          completedAt={reasoning.span.end}
          timestamp={reasoning.span.start}
        />
      </span>
      {open && (
        <div className={REASONING_BODY_CLASS} data-slot="aui_thinking-body">
          {reasoning.texts.map((text, index) => (
            <MarkdownTextContent
              containerClassName="text-xs leading-snug text-muted-foreground/85"
              containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
              isRunning={reasoning.pending && index === reasoning.texts.length - 1}
              key={index}
              scratchpad
              text={separateGluedReasoningBlocks(text)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** A running terminal or code call can be waiting on the user's approval. Its
 *  row is folded away, so the approval bar hangs off the process line. */
function PendingApproval({ process }: { process: TurnProcess }) {
  const step = process.current === null ? null : process.steps[process.current]
  const call = step?.calls.findLast(item => item.state === 'running' && APPROVAL_TOOLS.has(item.toolName))

  return call ? <PendingToolApproval part={call.part as ToolPart} /> : null
}

function Header({
  expanded,
  line,
  onToggle,
  span,
  toggleable
}: {
  expanded: boolean
  line: StatusLine
  onToggle: () => void
  span: TurnProcess['span']
  toggleable: boolean
}) {
  const { t } = useI18n()
  const copy = t.assistant.tool.process
  const live = line.state === 'running'

  return (
    <div
      aria-live={live ? 'polite' : undefined}
      className={cn(LINE_CLASS, 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5')}
      data-process-status=""
      data-state={line.state}
      role={live ? 'status' : undefined}
    >
      <span className={cn(SCAFFOLD_GLYPH_CLASS, 'self-center')}>
        <StateGlyph state={line.state} />
      </span>
      <span
        className={cn(
          'min-w-0 font-medium text-(--ui-text-primary)',
          live && 'shimmer',
          line.state === 'failed' && 'text-destructive'
        )}
      >
        {line.text}
      </span>
      {line.meta.map(meta => (
        <span className={cn(SCAFFOLD_META_CLASS, 'text-[length:var(--conversation-caption-font-size)]')} key={meta}>
          {meta}
        </span>
      ))}
      {toggleable && (
        <button
          aria-expanded={expanded}
          className={LINK_BUTTON_CLASS}
          data-process-toggle=""
          onClick={onToggle}
          type="button"
        >
          {expanded ? copy.hideSteps : copy.showSteps}
        </button>
      )}
      <TimelineTimestamp className={cn(SCAFFOLD_META_CLASS, 'ms-auto')} completedAt={span.end} timestamp={span.start} />
    </div>
  )
}

function ProcessBody({ view }: { view: TurnView }) {
  const { t } = useI18n()
  const devMode = useStore($toolViewMode) === 'technical'
  const { process } = view
  const copy = t.assistant.tool.process
  const line = statusLine(process, copy)
  const stuck = process.phase === 'failed' || process.phase === 'stopped'
  const [expanded, toggle] = useDisclosure(`process:${view.key}`, devMode || stuck)
  const hasSteps = process.steps.length > 0 || (devMode && process.prepOnly.length > 0)
  const current = process.current === null ? null : process.steps[process.current]

  // A settled turn that only looked tools up has nothing a user would call a
  // step; the line would be empty words.
  if (!view.live && process.steps.length === 0 && process.skills.length === 0 && !devMode) {
    return process.reasoning.texts.length > 0 ? <ReasoningChip process={process} turnKey={view.key} /> : null
  }

  return (
    <>
      <Header expanded={expanded} line={line} onToggle={toggle} span={process.span} toggleable={hasSteps} />
      {expanded && hasSteps && <StepsList devMode={devMode} process={process} turnKey={view.key} />}
      <CreatorTipSlot
        current={current}
        devMode={devMode}
        linkClassName={LINK_BUTTON_CLASS}
        noteClassName={NOTE_CLASS}
        process={process}
        slowHint={copy.slowHint}
        turnKey={view.key}
      />
      {process.phase === 'running' && <PendingApproval process={process} />}
      {process.phase === 'failed' && <FailureCard process={process} view={view} />}
      <ReasoningChip process={process} turnKey={view.key} />
    </>
  )
}

/** The turn's process area. Rendered once per turn, in place of its last run
 *  of tool activity (see `turnAnchor`). */
export const TurnProcessBlock: FC = () => {
  const view = useTurnView()

  if (!view) {
    return null
  }

  return (
    <div
      className="grid min-w-0 max-w-full gap-1.5"
      data-conversation-scaffold=""
      data-process-block=""
      data-slot="tool-block"
    >
      <ProcessBody view={view} />
    </div>
  )
}
