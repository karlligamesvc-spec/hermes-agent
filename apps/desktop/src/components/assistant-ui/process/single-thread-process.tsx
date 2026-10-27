'use client'

import { useAuiState } from '@assistant-ui/react'
import type { FC } from 'react'

import { ApexAvatar } from '@/components/apex-avatar'
import { useStatusHint, useThreadSessionStatus } from '@/components/assistant-ui/thread/status'
import { SCAFFOLD_GLYPH_CLASS, SCAFFOLD_META_CLASS } from '@/components/chat/scaffold-row'
import { useI18n } from '@/i18n'
import { useSingleThreadCopy } from '@/i18n/single-thread'
import { cn } from '@/lib/utils'
import { useSingleThreadMode } from '@/store/single-thread'
import { ThreadActivityPresence } from '@/store/thread-signals'

import { CreatorTipSlot } from './creator-tip'
import { plainStageLine } from './plain-steps'
import {
  FailureCard,
  LINE_CLASS,
  LINK_BUTTON_CLASS,
  NOTE_CLASS,
  PendingApproval,
  StateGlyph,
  statusLine,
  StepsList,
  useDisclosure
} from './process-block'
import { SingleThreadStopButton } from './single-thread-stop'
import { type TurnProcess, wholeSeconds } from './turn-process'
import { turnBounds, useTurnView } from './turn-state'

/**
 * hc-1015 「只有问题和回复」: where a turn's work goes in single-thread mode.
 *
 * Kael 2026-10-21 (decision 6): one line of status, and 「看过程」 under the
 * result. While the turn runs, its work is one activity line at the foot of the
 * conversation, the way Grok Bot and Muse show it: APEX's avatar, looking down
 * at the work (hc-1064), and what it is doing now (「正在识别语音… 第 2 步」),
 * 「等你决定」 while a question or an approval waits. Once it is done the answer
 * stands alone, with 「用时 2 分 10 秒 · 看过程」 under it opening the same
 * plain-language steps and sources as the process block. Thoughts are not
 * shown.
 *
 * What protects the user stays: an approval bar for a command hangs off the
 * activity line exactly as it hangs off the process line, a stuck task keeps
 * its failure card and its three ways on, and question cards stay where they
 * were asked. Developer mode never reaches this file.
 */

const ACTIVITY_CLASS = cn(
  LINE_CLASS,
  'flex min-w-0 max-w-full items-center gap-2 self-start text-(--conversation-scaffold-text)'
)

/** The activity line, in place of the tail's loading and activity rows. */
export const SingleThreadActivityLine: FC = () => {
  const { t } = useI18n()
  const copy = useSingleThreadCopy()
  const { awaitingInput, busy, compacting } = useThreadSessionStatus()
  // Only compaction is named: a provider's wait frame and a drafting tool's
  // verb come from the engine in its own words, which is the mechanism this
  // mode keeps out of sight.
  const compactingHint = useStatusHint(compacting, null, '')
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')
  const view = useTurnView()

  if (!busy && !messageRunning) {
    return null
  }

  const processCopy = t.assistant.tool.process
  const process = view?.process ?? null
  const line = process ? statusLine(process, processCopy) : null
  const stepLine = line?.state === 'running' ? line : null
  const current = process && process.current !== null ? process.steps[process.current] : null

  const text = awaitingInput
    ? copy.waitingForYou
    : compactingHint || (stepLine ? stepLine.text : processCopy.status.thinking)

  const meta = awaitingInput || compactingHint || !stepLine ? [] : stepLine.meta

  return (
    <div className="grid min-w-0 max-w-full gap-1" data-conversation-scaffold="" data-single-thread-activity="">
      <div aria-label={copy.activity} aria-live="polite" className={ACTIVITY_CLASS} role="status">
        <ApexAvatar className="size-[1.375rem]" mood={awaitingInput ? 'idle' : 'working'} />
        <span className={cn('min-w-0 truncate', !awaitingInput && 'shimmer')}>{text}</span>
        {meta.map(item => (
          <span className={cn(SCAFFOLD_META_CLASS, 'text-[length:var(--conversation-caption-font-size)]')} key={item}>
            {item}
          </span>
        ))}
        <SingleThreadStopButton />
      </div>
      <StageLine process={process} />
      {process?.phase === 'running' && <PendingApproval process={process} />}
      {process && view && (
        <CreatorTipSlot
          current={current}
          devMode={false}
          linkClassName={LINK_BUTTON_CLASS}
          noteClassName={NOTE_CLASS}
          process={process}
          slowHint={processCopy.slowHint}
          turnKey={view.key}
        />
      )}
      <ThreadActivityPresence text={text} waiting={awaitingInput} />
    </div>
  )
}

/** hc-1066: where a long task stands — 「已看完素材、生成好素材，正在剪辑」. */
function StageLine({ process }: { process: null | TurnProcess }) {
  const stage = process ? plainStageLine(process.steps) : null

  return stage ? (
    <p className={cn(NOTE_CLASS, 'm-0 ps-[1.875rem]')} data-single-thread-stage="">
      {stage}
    </p>
  ) : null
}

interface TurnEndSlice {
  message: { id: string; index?: number }
  thread: { messages: readonly { id: string; role: string }[] }
}

/** Under the answer: once per turn, on the turn's last bubble, in single-thread mode only. */
export const SingleThreadProcessFooter: FC = () => {
  const on = useSingleThreadMode()

  const turnEnd = useAuiState((state: TurnEndSlice) => {
    const bounds = turnBounds(state.thread.messages, state.message.id, state.message.index)

    return Boolean(bounds) && state.thread.messages[bounds!.end]?.id === state.message.id
  })

  return on && turnEnd ? <TurnProcessFooter /> : null
}

function TurnProcessFooter() {
  const { t } = useI18n()
  const copy = useSingleThreadCopy()
  const view = useTurnView()
  // N10 (hc-1063): no 「用到的方法：…」 — it names the skills, the mechanism this mode keeps out of sight.
  const process = view?.process ? { ...view.process, skills: [] } : null
  const stuck = process?.phase === 'failed' || process?.phase === 'stopped'
  const [open, toggle] = useDisclosure(`process:${view?.key ?? ''}`, stuck)

  if (!view || !process || view.live) {
    return null
  }

  const processCopy = t.assistant.tool.process
  const hasProcess = process.steps.length > 0

  if (!hasProcess && process.phase !== 'failed') {
    return null
  }

  const line = statusLine(process, processCopy)
  const took = wholeSeconds(process.durationS)

  return (
    <div
      className="grid min-w-0 max-w-full gap-1.5 pt-1"
      data-conversation-scaffold=""
      data-single-thread-process=""
      data-state={process.phase}
    >
      <div
        className={cn(NOTE_CLASS, 'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5')}
        data-process-status=""
        data-state={line.state}
      >
        {stuck ? (
          <>
            <span className={cn(SCAFFOLD_GLYPH_CLASS, 'self-center')}>
              <StateGlyph state={line.state} />
            </span>
            <span className={cn('font-medium text-(--ui-text-primary)', line.state === 'failed' && 'text-destructive')}>
              {line.text}
            </span>
            {line.meta.map(item => (
              <span key={item}>{item}</span>
            ))}
          </>
        ) : (
          took && <span>{processCopy.status.took(took)}</span>
        )}
        {hasProcess && (
          <>
            {(stuck || took) && <span aria-hidden="true">·</span>}
            <button
              aria-expanded={open}
              className={LINK_BUTTON_CLASS}
              data-process-toggle=""
              onClick={toggle}
              type="button"
            >
              {open ? copy.hideProcess : copy.showProcess}
            </button>
          </>
        )}
      </div>
      {open && hasProcess && <StepsList devMode={false} process={process} turnKey={view.key} />}
      <CreatorTipSlot
        current={null}
        devMode={false}
        linkClassName={LINK_BUTTON_CLASS}
        noteClassName={NOTE_CLASS}
        process={process}
        slowHint={processCopy.slowHint}
        turnKey={view.key}
      />
      {process.phase === 'failed' && <FailureCard process={process} view={view} />}
    </div>
  )
}
