'use client'

import { useAuiState } from '@assistant-ui/react'
import { Children, type FC, Fragment, type PropsWithChildren, useMemo } from 'react'

import { useSingleThreadMode } from '@/store/single-thread'

import { TurnProcessBlock } from './process-block'
import { processKind, type TurnPart } from './turn-process'
import { useTurnAnchor } from './turn-state'

export type ProcessItem = { end: number; kind: 'run'; start: number } | { index: number; kind: 'card' }

/**
 * Split a range of parts into cards and the runs of activity between them,
 * in the order they happened. Indices are relative to the range; a part that
 * is not a tool call at all passes through as its own card.
 */
export function splitProcessItems(kinds: readonly string[]): ProcessItem[] {
  const items: ProcessItem[] = []
  let run: null | Extract<ProcessItem, { kind: 'run' }> = null

  kinds.forEach((kind, index) => {
    if (kind === 'card') {
      run = null
      items.push({ index, kind: 'card' })

      return
    }

    if (run) {
      run.end = index
    } else {
      run = { end: index, kind: 'run', start: index }
      items.push(run)
    }
  })

  return items
}

/**
 * A range of consecutive tool calls (assistant-ui hands each one over whole).
 *
 * Cards — an edit, an image, a question for the user — stay where they
 * happened. Activity is folded into the turn's one process block, which this
 * range draws only if it holds the turn's last run of activity
 * (`turnAnchor`): every other run of the turn is already a step in that
 * block, so it draws nothing here.
 */
export const ProcessToolGroupSlot: FC<PropsWithChildren<{ endIndex: number; startIndex: number }>> = ({
  children,
  endIndex,
  startIndex
}) => {
  // Joined rather than returned as an array: assistant-ui compares selector
  // results with `Object.is` and re-runs them on every store update, so a
  // fresh array would re-render the whole group on every text delta.
  const kindKey = useAuiState(state =>
    state.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .map(part => (part.type === 'tool-call' ? processKind(part as TurnPart) : 'card'))
      .join('|')
  )

  const messageId = useAuiState(state => state.message.id)
  // hc-1015: in single-thread mode the turn's work is the activity line and
  // the 「看过程」 line under the answer (single-thread-process.tsx), not a block.
  const singleThread = useSingleThreadMode()
  const turnAnchor = useTurnAnchor()
  const anchor = singleThread ? '' : turnAnchor
  const items = useMemo(() => splitProcessItems(kindKey.split('|')), [kindKey])
  const rows = Children.toArray(children)

  return (
    <>
      {items.map(item =>
        item.kind === 'card' ? (
          <Fragment key={`card:${item.index}`}>{rows[item.index]}</Fragment>
        ) : anchor === `${messageId}:${startIndex + item.start}` ? (
          <TurnProcessBlock key={`process:${item.start}`} />
        ) : null
      )}
    </>
  )
}
