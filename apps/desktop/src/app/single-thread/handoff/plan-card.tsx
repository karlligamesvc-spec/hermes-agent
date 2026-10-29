/**
 * hc-1091 多助手二期 R6: the relay plan card (一条龙接力), prototype v2
 * artboard ⑬. A reply that ends in an `apex:plan` block (lib/handoff-plan.ts)
 * shows it under its text, in the assistant's own 「APEX 主线」 while relay is
 * on; anywhere else (relay off, developer mode, an earlier conversation) it
 * draws nothing, so the transcript's DOM is what it was
 * (handoff-plan-identity.test.tsx).
 *
 * - Proposed (the newest finished reply only): each baton — who, what, 「已有」
 *   or 「多跑 1 个回合」 — R5's usage line for every turn the plan runs, and
 *   「开始」 / 「改一下」. 「开始」 is held back when the allowance is used up,
 *   another plan runs, the sign-in check is pending or the plan cannot run as
 *   written; a refusal after the click says why in hc-1087's words.
 * - Started: each baton's state from its relay (hc-1086); waiting on the user,
 *   it jumps to the receiver; 「停下」 / 「剩下的不做了」; held at a failed baton
 *   (or a next baton that could not start), 「再试一次」 after the usage check.
 * - Done: the last baton's summary and files; 「一共多跑了 N 个回合」.
 *
 * The store (store/handoff-plan.ts) starts and moves the plan; this only reads
 * it and calls its actions.
 */

import { useAuiState, useMessagePartText } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ReactNode, useMemo, useState } from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import { ApexAvatar } from '@/components/apex-avatar'
import { useTurnView } from '@/components/assistant-ui/process/turn-state'
import { Button } from '@/components/ui/button'
import { type HandoffPlanCopy, type HandoffPlanProblem, useHandoffPlanCopy } from '@/i18n/handoff-plan'
import {
  handoffDuration,
  relayWaitingChip,
  relayWaitingNote,
  type SingleThreadHandoffCopy,
  useSingleThreadHandoffCopy
} from '@/i18n/single-thread-handoff'
import { type HandoffPlanBlock, parseHandoffPlan } from '@/lib/handoff-plan'
import { replyAttachments } from '@/lib/handoff-text'
import { visibleReplyText } from '@/lib/reply-markers'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import {
  $handoffPlans,
  cancelRestOfPlan,
  currentPlanBaton,
  handoffPlanKey,
  type HandoffPlanRecord,
  type HandoffPlanStep,
  planForCard,
  planRelaySteps,
  retryHandoffPlan,
  runningHandoffPlan,
  startHandoffPlan,
  type StartHandoffPlanRefusal,
  stopHandoffPlan
} from '@/store/handoff-plan'
import { cleanBotName } from '@/store/single-thread-bot-ops'
import { $botRoster, type ApexBot, openBot } from '@/store/single-thread-bots'
import {
  $handoffs,
  handoffAccountOf,
  handoffQueuePosition,
  type HandoffRecord,
  isHandoffActive
} from '@/store/single-thread-handoff'
import { $handoffReceiverNames } from '@/store/single-thread-handoff-confirm'

import { Actions, CARD_CLASS, CardHead, Chip, type ChipTone, META_CLASS, QUOTE_CLASS, ReturnedItems } from './cards'
import { $handoffThreadProfile } from './slots'
import { type HandoffUsageLine, useHandoffUsageLine } from './usage-line'

interface MessageSlice {
  message: { createdAt?: unknown; id: string }
  thread: { messages: readonly { id: string }[] }
}

/** Every assistant text part mounts this (next to the 「下一步」 buttons); only a settled plan reply goes further. */
export function HandoffPlanSlot() {
  const profile = useStore($handoffThreadProfile)
  const { status, text } = useMessagePartText()

  if (!profile || status.type === 'running' || !text.includes('apex:plan')) {
    return null
  }

  return <PlanReply profile={profile} text={text} />
}

function PlanReply({ profile, text }: { profile: string; text: string }) {
  const block = useMemo(() => parseHandoffPlan(text).block, [text])

  return block ? <PlanCard block={block} profile={profile} text={text} /> : null
}

// ── reading the block against the roster ─────────────────────────────────────

/** The roster row a baton names (as shown and stored, any case), the assistant on screen included. */
function rosterBot(name: string, roster: readonly ApexBot[]): ApexBot | null {
  const wanted = cleanBotName(name).toLocaleLowerCase()

  return roster.find(bot => cleanBotName(bot.name).toLocaleLowerCase() === wanted) ?? null
}

/** The block's batons with their assistants, or why it cannot run as written. */
function planSteps(
  block: HandoffPlanBlock,
  roster: readonly ApexBot[],
  planner: string
): { problem: HandoffPlanProblem | null; steps: HandoffPlanStep[] } {
  const steps: HandoffPlanStep[] = []
  let problem: HandoffPlanProblem | null = block.overCap ? { kind: 'over_cap', legs: block.legs.length } : null

  for (const leg of block.legs) {
    if (leg.kind === 'have') {
      steps.push(leg)

      continue
    }

    const bot = rosterBot(leg.to, roster)

    if (!bot || bot.profile === planner) {
      problem ??= bot ? { kind: 'self', name: bot.name } : { kind: 'unknown', name: leg.to }
    }

    steps.push({ ask: leg.ask, kind: 'relay', label: leg.label, name: bot?.name ?? leg.to, to: bot?.profile ?? '' })
  }

  return { problem, steps }
}

// ── the card ─────────────────────────────────────────────────────────────────

function PlanCard({ block, profile, text }: { block: HandoffPlanBlock; profile: string; text: string }) {
  const writtenAt = useAuiState((state: MessageSlice) => {
    const createdAt = state.message.createdAt

    return createdAt instanceof Date && Number.isFinite(createdAt.getTime()) ? createdAt.getTime() : null
  })

  const plans = useStore($handoffPlans)
  const account = handoffAccountOf(useStore($authState))
  const key = handoffPlanKey(profile, block.legs)
  const plan = planForCard(key, writtenAt, plans, account)

  return plan ? <PlanRunCard plan={plan} /> : <PlanProposal block={block} planKey={key} profile={profile} text={text} />
}

function StepRow({
  bot,
  chip,
  index,
  label,
  note,
  tone
}: {
  bot: ApexBot | null
  chip: string
  index: number
  label: string
  note?: ReactNode
  tone: ChipTone
}) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5" data-handoff-plan-step={index + 1}>
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold',
            tone === 'done'
              ? 'bg-[color-mix(in_srgb,var(--ui-green)_14%,transparent)] text-(--ui-green)'
              : 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
          )}
        >
          {tone === 'done' ? '✓' : index + 1}
        </span>
        {bot && <ApexAvatar className="size-5" color={bot.color} shape={bot.shape} />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Chip tone={tone}>{chip}</Chip>
      </div>
      {note && <span className="ps-7 text-xs leading-5 text-(--ui-text-tertiary)">{note}</span>}
    </li>
  )
}

/** Why 「开始」 is held back, or what went wrong after the click; null when it can go. */
function proposalNote({
  blocked,
  copy,
  handoffCopy,
  otherRunning,
  planner,
  problem,
  refusal,
  relays,
  usage
}: {
  blocked: boolean
  copy: HandoffPlanCopy
  handoffCopy: SingleThreadHandoffCopy
  otherRunning: boolean
  planner: string
  problem: HandoffPlanProblem | null
  refusal: null | StartHandoffPlanRefusal
  relays: Extract<HandoffPlanStep, { kind: 'relay' }>[]
  usage: HandoffUsageLine | null
}): null | string {
  if (problem) {
    return copy.problem(problem, planner)
  }

  if (blocked && usage?.blockedReason) {
    return usage.blockedReason
  }

  if (otherRunning || refusal === 'plan_running') {
    return copy.planRunning
  }

  if (!refusal || refusal === 'invalid') {
    return null
  }

  // 'nested' is about the planner; the others about the first baton's receiver.
  return handoffCopy.refusal(refusal, refusal === 'nested' ? planner : (relays[0]?.name ?? planner))
}

/** R5's line for every turn the plan runs, and its reminder past 80% (as hc-1087's confirm card draws them). */
function UsageLines({ usage }: { usage: HandoffUsageLine }) {
  return (
    <>
      <p
        className={cn(
          'm-0 rounded-[0.5625rem] bg-(--ui-bg-tertiary) px-2.5 py-1.5 text-xs leading-5',
          usage.tone === 'normal' ? 'text-(--ui-text-secondary)' : 'text-(--ui-orange)'
        )}
        data-handoff-usage={usage.tone}
      >
        {usage.text}
      </p>
      {usage.warning && usage.tone !== 'blocked' && (
        <p className="m-0 text-xs leading-5 text-(--ui-orange)" data-handoff-usage-warning="">
          {usage.warning}
        </p>
      )}
    </>
  )
}

function ProposalRows({
  copy,
  planner,
  profile,
  roster,
  steps
}: {
  copy: HandoffPlanCopy
  planner: string
  profile: string
  roster: readonly ApexBot[]
  steps: HandoffPlanStep[]
}) {
  const bot = (key: string) => roster.find(row => row.profile === key) ?? null

  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {steps.map((step, index) =>
        step.kind === 'have' ? (
          <StepRow
            bot={bot(profile)}
            chip={copy.haveChip}
            index={index}
            key={index}
            label={copy.leg(planner, step.label)}
            tone="done"
          />
        ) : (
          <StepRow
            bot={bot(step.to)}
            chip={copy.notStartedChip}
            index={index}
            key={index}
            label={copy.leg(step.name, step.label)}
            note={copy.oneMoreTurn}
            tone="wait"
          />
        )
      )}
    </ol>
  )
}

function PlanProposal({
  block,
  planKey,
  profile,
  text
}: {
  block: HandoffPlanBlock
  planKey: string
  profile: string
  text: string
}) {
  const view = useTurnView()
  const isLastMessage = useAuiState((state: MessageSlice) => state.thread.messages.at(-1)?.id === state.message.id)
  const messageId = useAuiState((state: MessageSlice) => state.message.id)
  const storedId = useStore(useSessionView().$storedId)
  const roster = useStore($botRoster)
  const plans = useStore($handoffPlans)
  const copy = useHandoffPlanCopy()
  const handoffCopy = useSingleThreadHandoffCopy()
  const account = handoffAccountOf(useStore($authState))
  const { problem, steps } = planSteps(block, roster, profile)
  const relays = planRelaySteps({ steps })
  const usage = useHandoffUsageLine(relays.length)
  const [refusal, setRefusal] = useState<null | StartHandoffPlanRefusal>(null)

  // Only the newest finished reply proposes; once the conversation moved on, an unstarted plan is gone.
  if (!view || view.live || !view.isLastTurn || !isLastMessage) {
    return null
  }

  const planner = roster.find(bot => bot.profile === profile)?.name ?? profile
  const blocked = usage?.tone === 'blocked'
  const accountPending = account === undefined
  const otherRunning = Boolean(runningHandoffPlan(plans, account))
  const note = proposalNote({ blocked, copy, handoffCopy, otherRunning, planner, problem, refusal, relays, usage })

  const start = () => {
    const visible = visibleReplyText(text)

    const result = startHandoffPlan({
      from: { messageId, profile, storedSessionId: storedId ?? null },
      key: planKey,
      previous: { text: visible, ...replyAttachments(visible) },
      steps
    })

    setRefusal(result.ok ? null : result.reason)
  }

  const edit = () => {
    requestComposerInsert(copy.editDraft, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
  }

  return (
    <section
      aria-label={copy.title(steps.length)}
      className={cn(CARD_CLASS, 'mt-2')}
      data-handoff-card="plan"
      data-handoff-plan-status="proposed"
    >
      <CardHead bot={null} title={copy.title(steps.length)} />
      <ProposalRows copy={copy} planner={planner} profile={profile} roster={roster} steps={steps} />
      {usage && !problem && <UsageLines usage={usage} />}
      {note && (
        <p className="m-0 text-xs text-destructive" role="alert">
          {note}
        </p>
      )}
      {accountPending && !note && <p className={META_CLASS}>{handoffCopy.accountPending}</p>}
      <Actions>
        {!problem && (
          <Button disabled={blocked || accountPending || otherRunning} onClick={start} size="sm" type="button">
            {copy.start}
          </Button>
        )}
        <Button onClick={edit} size="sm" type="button" variant="outline">
          {copy.edit}
        </Button>
      </Actions>
    </section>
  )
}

// ── a started plan ───────────────────────────────────────────────────────────

interface BatonView {
  chip: string
  tone: ChipTone
}

function batonView(
  record: HandoffRecord | null,
  plan: HandoffPlanRecord,
  copy: HandoffPlanCopy,
  handoffCopy: SingleThreadHandoffCopy,
  records: readonly HandoffRecord[]
): BatonView {
  if (!record) {
    return plan.status === 'running'
      ? { chip: copy.afterPreviousChip, tone: 'wait' }
      : { chip: copy.notRunChip, tone: 'wait' }
  }

  switch (record.status) {
    case 'queued':
      return record.queueReason === 'platform_busy_retry'
        ? { chip: handoffCopy.platformBusyChip, tone: 'wait' }
        : { chip: handoffCopy.queuedChip(handoffQueuePosition(record.id, records) ?? 1), tone: 'wait' }

    case 'running':
      return { chip: handoffCopy.runningChip, tone: 'run' }

    case 'waiting':
      return { chip: relayWaitingChip(handoffCopy, record.waitingFor), tone: 'wait' }

    case 'returned':
      return { chip: handoffCopy.returnedChip(''), tone: 'done' }

    case 'failed':
      return {
        chip: record.failure?.kind === 'interrupted' ? handoffCopy.interruptedChip : handoffCopy.failedChip,
        tone: 'fail'
      }

    case 'stopped':
      return { chip: handoffCopy.stoppedChip, tone: 'wait' }

    default:
      return { chip: handoffCopy.cancelledChip, tone: 'fail' }
  }
}

/** 1-based place of the plan's latest baton, 「已有」 counted (what 「停在第 N 棒」 says). */
function batonPlace(plan: HandoffPlanRecord): number {
  const have = plan.steps.filter(step => step.kind === 'have').length

  return have + Math.max(1, plan.batons.length)
}

/** Everything the started card reads, worked out once. */
interface RunState {
  plan: HandoffPlanRecord
  records: readonly HandoffRecord[]
  relays: Extract<HandoffPlanStep, { kind: 'relay' }>[]
  current: HandoffRecord | null
  currentStep: Extract<HandoffPlanStep, { kind: 'relay' }> | undefined
  planner: string
  nameOf: (step: HandoffPlanStep | undefined) => string
  bot: (profile: string) => ApexBot | null
  running: boolean
  waitingOnUser: boolean
  /** Held at its latest baton (failed or stopped), or a next baton held back for the user. */
  held: boolean
  lastResult: HandoffRecord['result']
}

function useRunState(plan: HandoffPlanRecord): RunState {
  const roster = useStore($botRoster)
  const records = useStore($handoffs)
  const names = useStore($handoffReceiverNames)
  const relays = planRelaySteps(plan)
  const current = currentPlanBaton(plan, records)
  const running = plan.status === 'running'
  const bot = (profile: string) => roster.find(row => row.profile === profile) ?? null

  const nameOf = (step: HandoffPlanStep | undefined) =>
    step?.kind === 'relay' ? (bot(step.to)?.name ?? names[step.to] ?? step.name) : ''

  const returned = plan.batons
    .map(id => records.find(record => record.id === id))
    .filter(record => record?.status === 'returned')

  return {
    bot,
    current,
    currentStep: relays[Math.max(0, plan.batons.length - 1)],
    held:
      running &&
      ((current !== null && (current.status === 'failed' || current.status === 'stopped')) ||
        (plan.hold !== null && plan.hold.kind !== 'nested')),
    lastResult: returned.at(-1)?.result ?? null,
    nameOf,
    plan,
    planner: bot(plan.from.profile)?.name ?? plan.from.name ?? plan.from.profile,
    records,
    relays,
    running,
    waitingOnUser: running && current?.status === 'waiting'
  }
}

function RunRows({ copy, handoffCopy, state }: RunCopy & { state: RunState }) {
  const { plan, records } = state
  let relayIndex = 0

  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {plan.steps.map((step, index) => {
        if (step.kind === 'have') {
          return (
            <StepRow
              bot={state.bot(plan.from.profile)}
              chip={copy.haveChip}
              index={index}
              key={index}
              label={copy.leg(state.planner, step.label)}
              tone="done"
            />
          )
        }

        const id = plan.batons[relayIndex]
        const record = id ? (records.find(candidate => candidate.id === id) ?? null) : null
        const shown = batonView(record, plan, copy, handoffCopy, records)

        relayIndex += 1

        return (
          <StepRow
            bot={state.bot(step.to)}
            chip={shown.chip}
            index={index}
            key={index}
            label={copy.leg(state.nameOf(step), step.label)}
            tone={shown.tone}
          />
        )
      })}
    </ol>
  )
}

interface RunCopy {
  copy: HandoffPlanCopy
  handoffCopy: SingleThreadHandoffCopy
}

function headChip({ copy, handoffCopy, state }: RunCopy & { state: RunState }): ReactNode {
  const { plan } = state

  if (plan.status === 'done') {
    const took = handoffDuration(handoffCopy, plan.finishedAt !== null ? plan.finishedAt - plan.createdAt : null)

    return <Chip tone="done">{copy.doneChip(took)}</Chip>
  }

  if (plan.status === 'ended') {
    return <Chip tone="wait">{copy.endedChip}</Chip>
  }

  if (state.held) {
    const heldBack = plan.hold !== null && plan.hold.kind !== 'nested'

    return <Chip tone="fail">{copy.heldChip(batonPlace(plan) + (heldBack ? 1 : 0))}</Chip>
  }

  return state.waitingOnUser ? (
    <Chip tone="wait">{relayWaitingChip(handoffCopy, state.current?.waitingFor)}</Chip>
  ) : (
    <Chip tone="run">{copy.runningChip}</Chip>
  )
}

const ALERT_CLASS = 'm-0 text-xs text-destructive'

/** Why a running plan is held back before its next baton; null when it is not. */
function holdNote({ copy, handoffCopy, state }: RunCopy & { state: RunState }): ReactNode {
  const hold = state.plan.hold

  if (!hold) {
    return null
  }

  if (hold.kind === 'nested') {
    return <p className={META_CLASS}>{copy.heldNested(state.planner)}</p>
  }

  return (
    <p className={ALERT_CLASS}>
      {hold.kind === 'used_up'
        ? hold.reason
        : handoffCopy.refusal(hold.reason, state.nameOf(state.relays[state.plan.batons.length]))}
    </p>
  )
}

/** What the latest baton is doing, in hc-1087's words. */
function batonNote({ copy, handoffCopy, state }: RunCopy & { state: RunState }): ReactNode {
  const { current } = state
  const name = state.nameOf(state.currentStep)

  switch (current?.status) {
    case 'waiting':
      return <p className="m-0 wrap-anywhere">{relayWaitingNote(handoffCopy, name, current.waitingFor)}</p>

    case 'queued':
      return <p className={META_CLASS}>{handoffCopy.queueNote(current.queueReason, name)}</p>

    case 'failed':
      return <p className="m-0 wrap-anywhere">{handoffCopy.failure(current.failure?.kind ?? 'turn_error', name)}</p>

    case 'stopped':
      return <p className={META_CLASS}>{handoffCopy.stoppedNote}</p>

    default:
      return state.plan.restCancelled ? <p className={META_CLASS}>{copy.restCancelledNote}</p> : null
  }
}

function runBody(props: RunCopy & { state: RunState }): ReactNode {
  const { plan } = props.state

  if (plan.status === 'ended' && plan.end) {
    return (
      <p className={META_CLASS}>
        {plan.end === 'baton_cancelled' && plan.cancelReason
          ? props.handoffCopy.cancelled(plan.cancelReason, props.state.nameOf(props.state.currentStep))
          : props.copy.ended(plan.end, batonPlace(plan))}
      </p>
    )
  }

  if (!props.state.running) {
    return null
  }

  return holdNote(props) ?? batonNote(props)
}

function RunActions({ copy, handoffCopy, onRetry, state }: RunCopy & { onRetry: () => void; state: RunState }) {
  const { current, currentStep, plan } = state
  const open = (profile: string) => void openBot(profile).catch(() => undefined)

  if (!state.running) {
    const last = state.relays[plan.batons.length - 1]

    return last && state.lastResult ? (
      <Actions>
        <Button onClick={() => open(last.to)} size="sm" type="button" variant="outline">
          {handoffCopy.openThread(state.nameOf(last))}
        </Button>
      </Actions>
    ) : null
  }

  if (state.held) {
    return (
      <Actions>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          {copy.retry}
        </Button>
        <Button onClick={() => cancelRestOfPlan(plan.id)} size="sm" type="button" variant="outline">
          {copy.cancelRest}
        </Button>
      </Actions>
    )
  }

  const more = plan.batons.length < state.relays.length && !plan.restCancelled && plan.hold?.kind !== 'nested'

  return (
    <Actions>
      {current && isHandoffActive(current) && currentStep && (
        <Button
          onClick={() => open(currentStep.to)}
          size="sm"
          type="button"
          variant={state.waitingOnUser ? 'default' : 'outline'}
        >
          {state.waitingOnUser ? handoffCopy.answer : handoffCopy.seeWork}
        </Button>
      )}
      <Button onClick={() => void stopHandoffPlan(plan.id)} size="sm" type="button" variant="outline">
        {copy.stop}
      </Button>
      {more && (
        <Button onClick={() => cancelRestOfPlan(plan.id)} size="sm" type="button" variant="ghost">
          {copy.cancelRest}
        </Button>
      )}
    </Actions>
  )
}

function PlanRunCard({ plan }: { plan: HandoffPlanRecord }) {
  const copy = useHandoffPlanCopy()
  const handoffCopy = useSingleThreadHandoffCopy()
  const state = useRunState(plan)
  const [held, setHeld] = useState<null | string>(null)
  const props = { copy, handoffCopy, state }
  const result = state.lastResult

  // 「再试一次」 reads the usage line first (store/handoff-plan.ts); used up, it says why and stays.
  const retry = () => void retryHandoffPlan(plan.id).then(setHeld)

  return (
    <section
      aria-label={copy.title(plan.steps.length)}
      className={cn(CARD_CLASS, 'mt-2')}
      data-handoff-card="plan"
      data-handoff-plan-id={plan.id}
      data-handoff-plan-status={plan.status}
    >
      <CardHead bot={null} title={copy.title(plan.steps.length)}>
        {headChip(props)}
      </CardHead>
      <RunRows {...props} />
      {runBody(props)}
      {plan.status === 'done' && result && (
        <>
          {result.summary && <p className={QUOTE_CLASS}>{result.summary}</p>}
          <ReturnedItems files={result.files} links={result.links} />
          <p className={META_CLASS}>{copy.doneNote(state.relays.length)}</p>
        </>
      )}
      {plan.status === 'ended' && result?.summary && <p className={QUOTE_CLASS}>{result.summary}</p>}
      {held && (
        <p className={ALERT_CLASS} role="alert">
          {held}
        </p>
      )}
      <RunActions {...props} onRetry={retry} />
    </section>
  )
}
