/**
 * hc-1061 G3: the two things only the conversation surfaces know, published for
 * the single-thread sidebar (single-thread-presence.ts reads them). A leaf
 * module on purpose: the activity line and the voice panel import it without
 * pulling the session stores into their import graph.
 */

import { atom } from 'nanostores'
import { useEffect } from 'react'

/** hc-1107: what a turn waiting on the user asks of them — a choice (a question card) or a yes/no (an approval and the like). */
export type WaitingAsk = 'choose' | 'confirm'

export interface ThreadActivity {
  text: string
  waiting: boolean
  /** hc-1107: while `waiting`, what it asks; absent, a choice. */
  ask?: null | WaitingAsk
}

/** What the activity line shows while it is on screen; null when it is not. */
export const $threadActivity = atom<null | ThreadActivity>(null)

/** A voice conversation is open on the main composer. */
export const $threadInCall = atom(false)

/** Rendered by the activity line: publishes what it says, and clears it when the line goes away. */
export function ThreadActivityPresence({ ask, text, waiting }: ThreadActivity): null {
  useEffect(() => {
    $threadActivity.set(ask ? { ask, text, waiting } : { text, waiting })
  }, [ask, text, waiting])

  useEffect(() => () => $threadActivity.set(null), [])

  return null
}

/** Called by the voice conversation panel: a call is open while it is mounted. */
export function useThreadInCall(): void {
  useEffect(() => {
    $threadInCall.set(true)

    return () => $threadInCall.set(false)
  }, [])
}
