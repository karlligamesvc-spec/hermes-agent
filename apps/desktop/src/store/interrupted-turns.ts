/**
 * hc-1100: the conversations whose turn was still running when APEX last
 * quit, as the main process's ledger (electron/apex-turn-ledger.ts) kept them.
 *
 * Read once per window. A conversation leaves the set once the renderer has
 * looked at it: settled when its last turn turns out to have an answer (it
 * finished while the window was closed), or kept on screen with 「上次被打断了」
 * until the next turn there.
 */

import { atom } from 'nanostores'

interface InterruptedTurnsBridge {
  interruptedTurns?: () => Promise<unknown>
  settleInterruptedTurns?: (ids: string[]) => void
}

export const $interruptedTurns = atom<ReadonlySet<string>>(new Set())

let loading: null | Promise<void> = null

function bridge(): InterruptedTurnsBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window.hermesDesktop as unknown as InterruptedTurnsBridge)
}

export function loadInterruptedTurns(): Promise<void> {
  loading ??= (async () => {
    try {
      const ids = await bridge()?.interruptedTurns?.()

      if (Array.isArray(ids)) {
        $interruptedTurns.set(new Set(ids.filter((id): id is string => typeof id === 'string')))
      }
    } catch {
      // An older shell has no ledger: nothing is listed.
    }
  })()

  return loading
}

export function settleInterruptedTurn(sessionId: string): void {
  const current = $interruptedTurns.get()

  if (!current.has(sessionId)) {
    return
  }

  const next = new Set(current)
  next.delete(sessionId)
  $interruptedTurns.set(next)
  bridge()?.settleInterruptedTurns?.([sessionId])
}

/** Tests only. */
export function resetInterruptedTurnsForTest(ids: readonly string[] = []): void {
  loading = Promise.resolve()
  $interruptedTurns.set(new Set(ids))
}
