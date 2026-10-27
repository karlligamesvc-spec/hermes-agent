/**
 * hc-1061 G3: the two things only the conversation surfaces know, published for
 * the single-thread sidebar (single-thread-presence.ts reads them). A leaf
 * module on purpose: the activity line and the voice panel import it without
 * pulling the session stores into their import graph.
 */

import { atom } from 'nanostores'
import { useEffect } from 'react'

export interface ThreadActivity {
  text: string
  waiting: boolean
}

/** What the activity line shows while it is on screen; null when it is not. */
export const $threadActivity = atom<null | ThreadActivity>(null)

/** A voice conversation is open on the main composer. */
export const $threadInCall = atom(false)

/** Rendered by the activity line: publishes what it says, and clears it when the line goes away. */
export function ThreadActivityPresence({ text, waiting }: ThreadActivity): null {
  useEffect(() => {
    $threadActivity.set({ text, waiting })
  }, [text, waiting])

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
