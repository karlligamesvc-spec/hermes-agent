// Global "agent is driving a browser / the desktop" indicator (hc-418).
//
// While a browser_* or computer_use tool is running, we record a lightweight
// descriptor keyed by session id. The status-stack reads it to paint a chip
// (with a Stop control) so the user always knows when the agent has taken hold
// of a real surface — a trust signal the in-thread card alone can't provide
// (the card scrolls away; this stays pinned above the composer).
//
// The record is set on tool.start and cleared on that tool's completion, on
// turn end (message.complete / message.start), and on cancel — so it disappears
// the instant nothing is being driven (⑤ zero-noise when idle).

import { atom } from 'nanostores'

import type { OperationSurface } from '@/lib/operation-tool'

export interface ActiveOperation {
  surface: OperationSurface
  /** Raw tool name, e.g. 'browser_navigate' or 'computer_use'. */
  toolName: string
  /** Action key — 'navigate'/'click'/… (browser) or the computer_use action. */
  action: string
  /** Short target line (hostname / element / app), may be empty. */
  target: string
  /** The tool_call id that opened this operation, for start/complete matching. */
  toolCallId: string
}

export const $activeOperationBySession = atom<Record<string, ActiveOperation>>({})

/**
 * Record (or refresh) the live operation for a session. Idempotent: repeated
 * starts for the same tool_call just update the target.
 */
export function setActiveOperation(sid: string, op: ActiveOperation): void {
  const map = $activeOperationBySession.get()
  const prev = map[sid]

  if (
    prev &&
    prev.toolCallId === op.toolCallId &&
    prev.toolName === op.toolName &&
    prev.action === op.action &&
    prev.target === op.target
  ) {
    return
  }

  $activeOperationBySession.set({ ...map, [sid]: op })
}

/**
 * Clear the live operation for a session. When `toolCallId` is provided, only
 * clears if it matches the recorded operation — so a late completion from an
 * already-superseded call can't wipe a newer operation.
 */
export function clearActiveOperation(sid: string, toolCallId?: string): void {
  const map = $activeOperationBySession.get()
  const current = map[sid]

  if (!current) {
    return
  }

  if (toolCallId && current.toolCallId !== toolCallId) {
    return
  }

  const { [sid]: _drop, ...rest } = map
  $activeOperationBySession.set(rest)
}
