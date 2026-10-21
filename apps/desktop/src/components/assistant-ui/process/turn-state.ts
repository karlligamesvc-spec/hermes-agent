import { useAuiState } from '@assistant-ui/react'
import { useRef } from 'react'

import { useI18n } from '@/i18n'

import {
  buildTurnProcess,
  buildTurnSteps,
  processKind,
  type TurnPart,
  type TurnProcess,
  type TurnSteps
} from './turn-process'

/**
 * A turn, as the process block reads it from the thread: every assistant
 * bubble between one user message and the next.
 *
 * A live turn is spread over several bubbles (narration seals one and the next
 * call opens another) while the same turn reloaded from history is one bubble,
 * so nothing here may depend on bubble boundaries — only on the order of the
 * parts across the whole turn.
 */

interface MessageLike {
  content?: readonly TurnPart[]
  id: string
  metadata?: { custom?: Record<string, unknown> }
  parts?: readonly TurnPart[]
  role: string
}

interface TurnStateSlice {
  message: { id: string; index?: number }
  thread: { isRunning: boolean; messages: readonly MessageLike[] }
}

export interface TurnBounds {
  end: number
  start: number
}

const partsOf = (message: MessageLike): readonly TurnPart[] => message.parts ?? message.content ?? []

/** The messages of the turn `messageId` belongs to. */
export function turnBounds(messages: readonly MessageLike[], messageId: string, hint?: number): null | TurnBounds {
  let index = hint !== undefined && messages[hint]?.id === messageId ? hint : -1

  for (let i = messages.length - 1; index < 0 && i >= 0; i -= 1) {
    if (messages[i].id === messageId) {
      index = i
    }
  }

  if (index < 0) {
    return null
  }

  let start = index
  let end = index

  while (start > 0 && messages[start - 1].role !== 'user') {
    start -= 1
  }

  while (end < messages.length - 1 && messages[end + 1].role !== 'user') {
    end += 1
  }

  return { end, start }
}

/**
 * Where the turn's process block goes, as `messageId:partIndex`: the first
 * call of the turn's last run of activity. '' when there is nothing to fold.
 *
 * The last run, not the first, so the line sits next to what the turn is doing
 * now while it works and right above the answer once it is done. A run is a
 * stretch of consecutive activity calls in one bubble — exactly what one
 * `ToolGroupSlot` run renders — and one that holds only silent calls (a todo
 * update) has nothing to show, so it cannot host the block.
 */
export function turnAnchor(messages: readonly MessageLike[], bounds: TurnBounds): string {
  let anchor = ''

  for (let m = bounds.start; m <= bounds.end; m += 1) {
    const message = messages[m]

    if (message.role !== 'assistant') {
      continue
    }

    let runStart = -1
    let visible = false

    const close = () => {
      if (runStart >= 0 && visible) {
        anchor = `${message.id}:${runStart}`
      }

      runStart = -1
      visible = false
    }

    partsOf(message).forEach((part, index) => {
      const kind = part.type === 'tool-call' ? processKind(part) : 'card'

      if (kind === 'card') {
        close()

        return
      }

      if (runStart < 0) {
        runStart = index
      }

      visible ||= kind === 'activity'
    })

    close()
  }

  return anchor
}

function turnParts(messages: readonly MessageLike[], bounds: TurnBounds): TurnPart[] {
  const parts: TurnPart[] = []

  for (let m = bounds.start; m <= bounds.end; m += 1) {
    if (messages[m].role === 'assistant') {
      parts.push(...partsOf(messages[m]))
    }
  }

  return parts
}

/** The block's anchor for the turn this message belongs to (see `turnAnchor`). */
export function useTurnAnchor(): string {
  return useAuiState((state: TurnStateSlice) => {
    const bounds = turnBounds(state.thread.messages, state.message.id, state.message.index)

    return bounds ? turnAnchor(state.thread.messages, bounds) : ''
  })
}

export interface TurnView {
  /** This turn is the newest in the thread: the one follow-ups continue. */
  isLastTurn: boolean
  /** Stable across the turn's life: its first assistant bubble. */
  key: string
  live: boolean
  process: TurnProcess
}

interface TurnCache {
  calls: readonly TurnPart[]
  callSignature: string
  signature: string
  steps: TurnSteps
  value: TurnView
}

function partSignature(part: TurnPart): string {
  if (part.type === 'tool-call') {
    return `t:${part.toolCallId ?? ''}:${part.result === undefined ? 0 : 1}:${part.isError ? 1 : 0}:${part.completedAt ?? ''}`
  }

  if (part.type === 'reasoning') {
    return `r:${typeof part.text === 'string' ? part.text.length : 0}:${part.completedAt ?? ''}:${part.status?.type ?? ''}`
  }

  return part.type
}

/**
 * The whole turn's process, rebuilt only when something it shows changed.
 *
 * assistant-ui calls a selector on every store update and compares results
 * with `Object.is`, so a fresh object here would re-render the block on every
 * streamed token of the reply. Two signatures keep it quiet: the calls (each
 * one's progress, plus a reference check for arguments or results that land
 * on a call it already knew) gate the expensive fold into steps, and the rest
 * of the turn — how far each thought has got, whether text is streaming —
 * gates the cheap remainder. Reply text itself is not in either.
 */
export function useTurnView(): null | TurnView {
  const { locale } = useI18n()
  const cache = useRef<null | TurnCache>(null)

  return useAuiState((state: TurnStateSlice) => {
    const messages = state.thread.messages
    const bounds = turnBounds(messages, state.message.id, state.message.index)

    if (!bounds) {
      return null
    }

    const parts = turnParts(messages, bounds)
    const calls = parts.filter(part => part.type === 'tool-call')
    const isLastTurn = bounds.end === messages.length - 1
    // The thread runs one turn at a time, and it is the newest one. Reading
    // the bubble's own status instead would flicker the turn to "done" in the
    // gap between a sealed narration bubble and the next one opening.
    const live = state.thread.isRunning && isLastTurn
    const last = messages[bounds.end]
    const durationS = typeof last.metadata?.custom?.durationS === 'number' ? last.metadata.custom.durationS : undefined
    const lastProse = parts.findLastIndex(part => part.type === 'text' || part.type === 'reasoning')

    const callSignature = calls.map(partSignature).concat(String(live), String(lastProse), locale).join('|')

    const sameCalls =
      cache.current?.calls.length === calls.length &&
      calls.every((call, index) => {
        const previous = cache.current!.calls[index]

        return call.args === previous.args && call.result === previous.result
      })

    const steps =
      cache.current && cache.current.callSignature === callSignature && sameCalls
        ? cache.current.steps
        : buildTurnSteps(parts, live)

    const signature = parts
      .map(partSignature)
      .concat(String(live), String(isLastTurn), String(durationS ?? ''), messages[bounds.start].id, locale)
      .join('|')

    if (cache.current?.signature !== signature || cache.current.steps !== steps) {
      cache.current = {
        calls,
        callSignature,
        signature,
        steps,
        value: {
          isLastTurn,
          key: messages[bounds.start].id,
          live,
          process: buildTurnProcess(parts, live, durationS, steps)
        }
      }
    }

    return cache.current.value
  })
}
