/**
 * hc-1113: the road a Quick Entry line takes after Enter, and what happens
 * when it does not arrive.
 *
 * The quick window hands its line to main; main hands it to the primary
 * renderer with an id, and that renderer answers with receipts: `accepted` as
 * soon as its bridge holds the line, then `delivered` or `failed`. Every line
 * ends in exactly one desktop.log line, which never carries the text. A line
 * that did not land goes back to the quick window: it is shown again with the
 * text in the input and a sentence saying why, so nothing typed there is lost
 * without a word.
 *
 * The quick window also learns which assistant it is talking to from here:
 * main keeps the primary renderer's latest state push and hands it over with
 * every summon (`shown`) and to a freshly loaded window, so the name in the
 * window is the one on screen when the chord is pressed, not whatever an
 * earlier push left behind.
 *
 * Electron-free: main.ts injects the windows, the log sink and the timers.
 */

/** No `accepted` from the primary renderer within this long: its bridge is not there to take the line. */
export const QUICK_ENTRY_ACK_TIMEOUT_MS = 5_000

/** An accepted line with no final receipt after this long (a held switch waits up to 30 s). */
export const QUICK_ENTRY_RECEIPT_TIMEOUT_MS = 60_000

export type QuickEntryFailureReason = 'busy' | 'error' | 'no-answer' | 'no-window' | 'refused' | 'switch'

const FAILURE_REASONS: ReadonlySet<string> = new Set(['busy', 'error', 'no-answer', 'no-window', 'refused', 'switch'])

/** Where a delivered line went, for the log: the chat on screen, a new one, or a stored session. */
const DELIVERY_KINDS: ReadonlySet<string> = new Set(['current', 'new', 'session'])

/** The assistant the quick window named when the line was typed (several assistants on), else absent. */
export interface QuickEntryAssistantRef {
  name: string
  profile: string
}

/** A line on its way from the quick window to the primary renderer. */
export interface QuickEntryCapture {
  assistant: null | QuickEntryAssistantRef
  target: string
  text: string
}

/** Sent back to the quick window when a line did not land. */
export interface QuickEntryFailure {
  name: null | string
  reason: QuickEntryFailureReason
  text: string
}

interface ContentsLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface QuickEntryRelayDeps {
  log: (line: string) => void
  /** The primary window's webContents, or null when the window is closed. */
  primary: () => ContentsLike | null
  /** The quick window's webContents, or null when there is none. */
  quick: () => ContentsLike | null
  hideQuick: () => void
  /** Bring the quick window up again (spawning it when needed). */
  showQuick: () => void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface QuickEntryRelay {
  /** Quick window → main: a line was submitted. */
  submit(raw: unknown): void
  /** Primary renderer → main: what became of a line. */
  receipt(raw: unknown): void
  /** Primary renderer → main: its latest state for the quick window. */
  state(payload: unknown): void
  /** A quick window finished loading: give it the latest state (and a pending failure). */
  replay(contents: ContentsLike): void
  /** The quick window was summoned again: tell it, with the latest state (and a pending failure). */
  shown(contents: ContentsLike): void
}

function clamp(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function assistantOf(raw: unknown): null | QuickEntryAssistantRef {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const record = raw as Record<string, unknown>
  const profile = clamp(record.profile, 128)

  return profile ? { name: clamp(record.name, 64) || profile, profile } : null
}

/** The quick window's payload → a capture, or null for nothing to send. */
export function quickEntryCaptureOf(raw: unknown): null | QuickEntryCapture {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const text = typeof record.text === 'string' ? record.text.trim() : ''

  if (!text) {
    return null
  }

  return {
    assistant: assistantOf(record.assistant),
    target: typeof record.target === 'string' && record.target ? record.target : 'current',
    text
  }
}

/** Who a line was for, as the log names it (a profile key, never the text). */
function whom(capture: QuickEntryCapture, profile?: unknown): string {
  const named = clamp(profile, 128) || capture.assistant?.profile

  return named ? `"${named}"` : 'the chat on screen'
}

export function createQuickEntryRelay(deps: QuickEntryRelayDeps): QuickEntryRelay {
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const inFlight = new Map<string, { capture: QuickEntryCapture; timer: unknown }>()
  let lastState: null | Record<string, unknown> = null
  let failure: null | QuickEntryFailure = null
  let serial = 0

  const live = (contents: ContentsLike | null) => (contents && !contents.isDestroyed() ? contents : null)

  // One pending failure rides the next message the quick window gets, then it is spent.
  const handover = () => {
    const payload = failure ? { ...(lastState ?? {}), failure } : lastState
    failure = null

    return payload
  }

  const fail = (capture: QuickEntryCapture, reason: QuickEntryFailureReason, detail: string) => {
    deps.log(`[quick-entry] not delivered to ${whom(capture)}: ${reason} (${detail})`)
    failure = { name: capture.assistant?.name ?? null, reason, text: capture.text }
    deps.showQuick()
  }

  const arm = (id: string, ms: number, detail: string) => {
    const entry = inFlight.get(id)

    if (!entry) {
      return
    }

    clearTimer(entry.timer)
    entry.timer = setTimer(() => {
      inFlight.delete(id)
      fail(entry.capture, 'no-answer', detail)
    }, ms)
  }

  return {
    submit(raw) {
      deps.hideQuick()
      const capture = quickEntryCaptureOf(raw)

      if (!capture) {
        return
      }

      const primary = live(deps.primary())

      if (!primary) {
        fail(capture, 'no-window', 'the main window is closed')

        return
      }

      serial += 1
      const id = `qe-${serial}`
      inFlight.set(id, { capture, timer: null })
      arm(id, QUICK_ENTRY_ACK_TIMEOUT_MS, `the main window did not take it within ${QUICK_ENTRY_ACK_TIMEOUT_MS} ms`)
      primary.send('hermes:quick-entry:submit', { ...capture, id })
    },
    receipt(raw) {
      const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const id = typeof record.id === 'string' ? record.id : ''
      const entry = inFlight.get(id)

      if (!entry) {
        return
      }

      if (record.stage === 'accepted') {
        arm(id, QUICK_ENTRY_RECEIPT_TIMEOUT_MS, `no answer within ${QUICK_ENTRY_RECEIPT_TIMEOUT_MS} ms`)

        return
      }

      clearTimer(entry.timer)
      inFlight.delete(id)

      if (record.stage === 'delivered') {
        const kind = DELIVERY_KINDS.has(String(record.kind)) ? String(record.kind) : 'current'
        deps.log(`[quick-entry] delivered to ${whom(entry.capture, record.profile)} (${kind})`)

        return
      }

      const reason = FAILURE_REASONS.has(String(record.reason)) ? (record.reason as QuickEntryFailureReason) : 'error'
      fail(entry.capture, reason, clamp(record.detail, 200) || 'the main window could not send it')
    },
    state(payload) {
      lastState = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
      live(deps.quick())?.send('hermes:quick-entry:state', payload)
    },
    replay(contents) {
      const payload = handover()

      if (payload && !contents.isDestroyed()) {
        contents.send('hermes:quick-entry:state', payload)
      }
    },
    shown(contents) {
      contents.send('hermes:quick-entry:shown', handover())
    }
  }
}
