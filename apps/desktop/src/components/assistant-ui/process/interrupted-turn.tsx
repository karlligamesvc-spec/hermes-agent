'use client'

import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, useEffect } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useSingleThreadInterruptedCopy } from '@/i18n/single-thread-interrupted'
import { cn } from '@/lib/utils'
import { $interruptedTurns, loadInterruptedTurns, settleInterruptedTurn } from '@/store/interrupted-turns'
import { $gatewayState, $selectedStoredSessionId } from '@/store/session'

import { FailureActions, LINE_CLASS } from './process-block'
import type { TurnPart } from './turn-process'
import { turnBounds, turnParts, useTurnView } from './turn-state'

/**
 * hc-1100: 「上次被打断了」 under the last turn of a conversation that quitting
 * APEX cut off, in single-thread mode only.
 *
 * Two facts have to agree. The main process's ledger says the conversation
 * still had a turn running when APEX last quit (store/interrupted-turns.ts),
 * and the turn itself has no answer after its last step. A listed turn that
 * did get its answer finished while the window was closed: it is settled and
 * nothing shows. The three ways on are hc-973's, for the step it stopped in;
 * a turn cut off before its first step gets one 「接着做」.
 *
 * Known boundary: a turn cut off while it was writing its final answer keeps
 * the words it had written, which read as an answer; it shows nothing.
 */

/** No answer after the turn's last step, or no answer at all. */
export function turnUnfinished(parts: readonly TurnPart[]): boolean {
  const lastText = parts.findLastIndex(
    part => part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== ''
  )

  const lastCall = parts.findLastIndex(part => part.type === 'tool-call')

  return lastText < 0 || lastCall > lastText
}

interface TurnSlice {
  message: { id: string; index?: number }
  thread: { messages: Parameters<typeof turnParts>[0] }
}

export const InterruptedTurnNotice: FC = () => {
  const { t } = useI18n()
  const copy = useSingleThreadInterruptedCopy()
  const sessionId = useStore($selectedStoredSessionId)
  const listed = useStore($interruptedTurns)
  const gatewayState = useStore($gatewayState)
  const view = useTurnView()

  const unfinished = useAuiState((state: TurnSlice) => {
    const bounds = turnBounds(state.thread.messages, state.message.id, state.message.index)

    return bounds ? turnUnfinished(turnParts(state.thread.messages, bounds)) : false
  })

  const candidate = Boolean(sessionId && listed.has(sessionId) && view?.isLastTurn && !view.live)

  useEffect(() => {
    void loadInterruptedTurns()
  }, [])

  useEffect(() => {
    if (candidate && !unfinished && sessionId) {
      settleInterruptedTurn(sessionId)
    }
  }, [candidate, unfinished, sessionId])

  if (!candidate || !unfinished || !view) {
    return null
  }

  const steps = view.process.steps
  const last = steps.length > 0 ? steps[steps.length - 1] : null
  const disabled = gatewayState !== 'open'

  return (
    <div
      className="grid gap-2 rounded-lg border border-(--ui-stroke-tertiary) px-3 py-2.5"
      data-interrupted-turn=""
      role="status"
    >
      <p className={cn(LINE_CLASS, 'm-0 flex flex-wrap gap-x-1 text-(--ui-text-primary)')}>
        <span>{copy.interrupted}</span>
        {last && <span>{t.assistant.tool.process.failure.keptNote}</span>}
      </p>
      {last ? (
        <FailureActions disabled={disabled} onAsk={requestComposerSubmit} title={last.copy.title} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => requestComposerSubmit(copy.goOnMessage)} size="sm" type="button">
            {copy.goOn}
          </Button>
        </div>
      )}
    </div>
  )
}
