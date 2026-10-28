/**
 * apex-turn-ledger.ts — which conversations still had a turn running when
 * APEX last quit (hc-1100).
 *
 * Quitting stops the engines mid-turn. The engine records the cut-off turn
 * with a hidden placeholder the transcript never shows, so reopening showed
 * the steps and no answer, as if the turn had simply ended. The renderer can
 * tell an unfinished turn from its shape, but not why it stopped; this ledger
 * supplies the why.
 *
 * Every window already reports its running conversations for the quit
 * confirmation (`hermes:active-work`, store/active-work.ts); the report also
 * carries their stored session ids. The ledger keeps the union on disk:
 * - a conversation leaves it when a live window sees its turn end;
 * - a window that goes away mid-turn (macOS keeps the app when the window
 *   closes) leaves its conversations in, since nobody watches them any more;
 * - once the quit teardown starts, the ledger freezes, so the turns the quit
 *   itself cuts off stay in.
 *
 * On the next launch the renderer asks for the ledger as the last run left it
 * and shows 「上次被打断了」 on each listed conversation whose last turn has no
 * answer, settling the rest. A turn that finished while its window was closed
 * has an answer, so it is settled without a word.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface TurnLedgerStore {
  read: () => null | string
  write: (text: string) => void
}

export interface TurnLedger {
  /** One window's running conversations, replacing its previous report. */
  report: (window: number, sessionIds: readonly string[]) => void
  /** The window is gone; what it was running stays listed. */
  windowGone: (window: number) => void
  /** The quit teardown has started: keep what is listed now. */
  freeze: () => void
  /** The conversations the previous run quit on. */
  interrupted: () => string[]
  /** The renderer has looked at these: drop them. */
  settle: (sessionIds: readonly string[]) => void
}

export const TURN_LEDGER_FILE = 'turns-in-flight.json'

export function sessionIdsOf(payload: unknown): string[] {
  const ids = (payload as { ids?: unknown } | null | undefined)?.ids

  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '') : []
}

function parseLedger(text: null | string): Set<string> {
  try {
    return new Set(sessionIdsOf(JSON.parse(text ?? '')))
  } catch {
    return new Set()
  }
}

export function createTurnLedger(store: TurnLedgerStore): TurnLedger {
  let previous: null | Set<string> = null
  const live = new Map<number, Set<string>>()
  const kept = new Set<string>()
  let frozen = false

  const loaded = () => (previous ??= parseLedger(store.read()))

  const runningElsewhere = (id: string, window: number) =>
    [...live].some(([other, ids]) => other !== window && ids.has(id))

  const persist = () => {
    const ids = new Set([...loaded(), ...kept, ...[...live.values()].flatMap(set => [...set])])

    try {
      store.write(JSON.stringify({ ids: [...ids] }))
    } catch {
      // A ledger that cannot be written only costs the notice.
    }
  }

  return {
    report(window, sessionIds) {
      if (frozen) {
        return
      }

      const next = new Set(sessionIds)

      for (const id of live.get(window) ?? []) {
        if (!next.has(id) && !runningElsewhere(id, window)) {
          loaded().delete(id)
          kept.delete(id)
        }
      }

      live.set(window, next)
      persist()
    },

    windowGone(window) {
      if (frozen) {
        return
      }

      for (const id of live.get(window) ?? []) {
        kept.add(id)
      }

      live.delete(window)
      persist()
    },

    freeze() {
      frozen = true
    },

    interrupted: () => [...loaded()],

    settle(sessionIds) {
      for (const id of sessionIds) {
        loaded().delete(id)
        kept.delete(id)
      }

      if (!frozen) {
        persist()
      }
    }
  }
}

/** The ledger file in `dir()` (userData, resolved on first use). */
export function turnLedgerStoreIn(dir: () => string): TurnLedgerStore {
  const file = () => path.join(dir(), TURN_LEDGER_FILE)

  return {
    read: () => {
      try {
        return fs.readFileSync(file(), 'utf8')
      } catch {
        return null
      }
    },
    write: text => {
      const target = file()
      const temp = `${target}.${process.pid}.tmp`

      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(temp, text, 'utf8')
      fs.renameSync(temp, target)
    }
  }
}

interface LedgerIpc {
  on: (channel: string, listener: (event: any, payload: unknown) => void) => unknown
  handle: (channel: string, listener: () => unknown) => unknown
}

/**
 * Wire the ledger to the windows' reports and the renderer's read / settle
 * calls. `quitting` is the local engines' shutdown signal: it aborts as the
 * quit teardown starts, before any engine is stopped.
 */
export function registerTurnLedger(ipc: LedgerIpc, store: TurnLedgerStore, quitting: AbortSignal): TurnLedger {
  const ledger = createTurnLedger(store)
  const watched = new Set<number>()

  quitting.addEventListener('abort', () => ledger.freeze(), { once: true })

  ipc.on('hermes:active-work', (event, payload) => {
    const window = event.sender.id

    if (!watched.has(window)) {
      watched.add(window)
      event.sender.once('destroyed', () => {
        watched.delete(window)
        ledger.windowGone(window)
      })
    }

    ledger.report(window, sessionIdsOf(payload))
  })
  ipc.handle('hermes:interrupted-turns', () => ledger.interrupted())
  ipc.on('hermes:interrupted-turns:settle', (_event, ids) => ledger.settle(sessionIdsOf({ ids })))

  return ledger
}
