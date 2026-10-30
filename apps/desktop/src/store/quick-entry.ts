/**
 * Quick Entry (renderer side) — the mini composer's own state, and the
 * primary window's bridge back into the real prompt-submit path.
 *
 * The quick window carries NO gateway connection: it hands its text to the main
 * process, which forwards it to the primary renderer, which sends it through the
 * SAME `submitText` the normal composer uses (see
 * app/contrib/hooks/use-quick-entry-bridge). There is no second submit path and
 * no new gateway RPC.
 *
 * The device-local preference (enabled + shortcut) is authoritative in the MAIN
 * process — it owns the OS registration and must restore it on a cold launch
 * without the renderer ever visiting Settings. This module treats what the
 * bridge returns as the truth and caches it for the settings UI, same authority
 * split as keep-awake.
 */

import { atom } from 'nanostores'

export interface QuickEntryState {
  enabled: boolean
  /** null before the first read; the settings row shows a skeleton until then. */
  registered: boolean | null
  /** Why the OS shortcut isn't live: taken by another app, or unusable. */
  error: null | QuickEntryRegistrationError
  shortcut: string
}

export type QuickEntryRegistrationError = 'invalid' | 'taken'

export interface QuickEntryStatus {
  enabled: boolean
  error: null | QuickEntryRegistrationError
  registered: boolean
  shortcut: string
}

export const QUICK_ENTRY_DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

export const $quickEntry = atom<QuickEntryState>({
  // Until main answers: its default for a missing file (QUICK_ENTRY_DEFAULT_ENABLED, electron/quick-entry.ts).
  enabled: false,
  error: null,
  registered: null,
  shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
})

function applyStatus(status: QuickEntryStatus | undefined): void {
  if (!status) {
    return
  }

  $quickEntry.set({
    enabled: status.enabled === true,
    error: status.error ?? null,
    registered: status.registered === true,
    shortcut: typeof status.shortcut === 'string' && status.shortcut ? status.shortcut : QUICK_ENTRY_DEFAULT_SHORTCUT
  })
}

/** True when the shell exposes the Quick Entry capability (desktop only). */
export function canUseQuickEntry(): boolean {
  return typeof window !== 'undefined' && typeof window.hermesDesktop?.quickEntry?.getSettings === 'function'
}

/** Read the live registration state into the store (Settings mount). */
export async function loadQuickEntrySettings(): Promise<void> {
  if (!canUseQuickEntry()) {
    return
  }

  try {
    applyStatus(await window.hermesDesktop.quickEntry.getSettings())
  } catch {
    // A failed read leaves the store as-is; the row keeps its last known copy.
  }
}

/**
 * Write a preference and adopt whatever the main process reports back — a
 * rejected shortcut or an already-taken chord comes back as an error state
 * instead of a silently-lost setting.
 */
export async function saveQuickEntrySettings(patch: { enabled?: boolean; shortcut?: string }): Promise<void> {
  if (!canUseQuickEntry()) {
    return
  }

  // Optimistic: paint the intent immediately, then let the authoritative reply
  // (which knows whether the OS accepted it) get the last word.
  const previous = $quickEntry.get()
  $quickEntry.set({ ...previous, ...patch, registered: previous.registered })

  try {
    applyStatus(await window.hermesDesktop.quickEntry.setSettings(patch))
  } catch {
    $quickEntry.set(previous)
  }
}

// ── Quick window submit state machine ───────────────────────────────────────

/** A recent session the quick window can target (pushed by the primary). */
export interface QuickEntrySessionOption {
  id: string
  /** Title, else preview; empty when it has neither (the window names it). */
  title: string
}

/** Send into whatever chat the main window currently has in front. */
export const QUICK_TARGET_CURRENT = 'current'
/** Start a brand-new session for this prompt. */
export const QUICK_TARGET_NEW = 'new'

/**
 * The primary renderer's push into the quick window: is the gateway usable, and
 * which recent sessions can be targeted. The quick window has NO gateway of its
 * own, so this pushed copy is its only view of backend truth — it starts
 * disconnected (input disabled) until the first push proves otherwise.
 */
export interface QuickEntryStatePush {
  connected: boolean
  sessions: QuickEntrySessionOption[]
  /**
   * hc-1113: the assistant on screen while several are on. Absent with one (and
   * from an older primary): the window then reads the name from localStorage.
   */
  assistant?: QuickEntryAssistantRef
  /** hc-1113: a line that did not land, handed back by main (electron/quick-entry-relay.ts). */
  failure?: null | QuickEntryFailure
}

/** An assistant as the quick window names it and a capture is routed to it. */
export interface QuickEntryAssistantRef {
  name: string
  profile: string
}

/** Why a line did not land (electron/quick-entry-relay.ts keeps the same list). */
export type QuickEntryFailureReason = 'busy' | 'error' | 'no-answer' | 'no-window' | 'refused' | 'switch'

/** A line that did not land: its text goes back into the input, with why. */
export interface QuickEntryFailure {
  name: null | string
  reason: QuickEntryFailureReason
  text: string
}

/** What a quick-window submit carries back to the primary renderer. */
export interface QuickEntrySubmitPayload {
  /** QUICK_TARGET_CURRENT, QUICK_TARGET_NEW, or a stored session id. */
  target: string
  text: string
  /** hc-1113: the assistant the window named when it was typed (several on). */
  assistant?: QuickEntryAssistantRef
  /** Set by main on the way to the primary renderer; its receipts carry it back. */
  id?: string
}

/** What became of a line, as the primary renderer reports it to main. */
export type QuickEntryDelivery =
  | { kind: 'current' | 'new' | 'session'; ok: true; profile: null | string }
  | { detail?: string; ok: false; profile: null | string; reason: QuickEntryFailureReason }

/** The primary renderer → main receipt for one line (see electron/quick-entry-relay.ts). */
export type QuickEntryReceipt =
  | { id: string; stage: 'accepted' }
  | ({ id: string; stage: 'delivered' } & Omit<Extract<QuickEntryDelivery, { ok: true }>, 'ok'>)
  | ({ id: string; stage: 'failed' } & Omit<Extract<QuickEntryDelivery, { ok: false }>, 'ok'>)

/**
 * The shell's Quick Entry bridge (preload `quickEntry`). Main owns the OS
 * shortcut and the stored preference, so the renderer reads and writes it here
 * and adopts the reply, which reports a chord another app holds as
 * `registered: false` + `error: 'taken'` instead of failing silently.
 */
export interface QuickEntryDesktopApi {
  getSettings: () => Promise<QuickEntryStatus>
  setSettings: (patch: { enabled?: boolean; shortcut?: string }) => Promise<QuickEntryStatus>
  /** Quick window → main: send this line (main hides the window and forwards it to the primary renderer). */
  submit: (payload: QuickEntrySubmitPayload) => void
  /** Quick window → main: hide without sending (Escape / blur). */
  dismiss: () => void
  /** Primary renderer → main → quick window: gateway state, recent sessions, the assistant on screen. */
  pushState: (payload: QuickEntryStatePush) => void
  /** Primary renderer → main: what became of a line (hc-1113; absent in an older shell). */
  receipt?: (receipt: QuickEntryReceipt) => void
  onState: (callback: (payload: QuickEntryStatePush) => void) => () => void
  /** Primary renderer: lines captured by the quick window. */
  onSubmit: (callback: (payload: QuickEntrySubmitPayload | string) => void) => () => void
  /** Quick window: summoned again, with main's latest state (and a line that did not land). */
  onShown: (callback: (payload?: null | QuickEntryStatePush) => void) => () => void
}

/**
 * The quick window's own composer state. Deliberately a tiny pure reducer: the
 * behavior that would actually break a user — an empty submit must not send but
 * must still not hide the window, a real submit clears the draft AND hides, a
 * double-fire while already submitting must not send twice, and a dead gateway
 * must disable sending entirely — is the part worth proving, and none of it
 * needs React or Electron.
 */
export interface QuickComposerState {
  /** Last pushed gateway truth. False (the initial value) disables submit. */
  connected: boolean
  draft: string
  /** Recent sessions the picker offers, pushed by the primary renderer. */
  sessions: QuickEntrySessionOption[]
  /** True between a send and the window actually hiding. Blocks a double-send. */
  submitting: boolean
  /** Where a submit lands: current / new / a stored session id. */
  target: string
  /** Whether the window should be visible. False asks the shell to hide. */
  visible: boolean
  /** hc-1113: the assistant the last push named as on screen; absent when it named none. */
  assistant?: QuickEntryAssistantRef
  /** hc-1113: the last line that did not land, shown under the input until the next send or dismiss. */
  failure: null | QuickEntryFailure
}

export type QuickComposerEvent =
  | { type: 'blur' }
  | { type: 'dismiss' }
  | { type: 'edit'; draft: string }
  | { type: 'failed'; failure: QuickEntryFailure }
  | { type: 'shown' }
  | {
      type: 'state'
      connected: boolean
      sessions: QuickEntrySessionOption[]
      assistant?: QuickEntryAssistantRef
    }
  | { type: 'submit' }
  | { type: 'target'; target: string }

export interface QuickComposerTransition {
  /** Payload to send through the real prompt-submit path, or null for none. */
  send: null | QuickEntrySubmitPayload
  state: QuickComposerState
}

export const initialQuickComposerState: QuickComposerState = {
  // Disconnected until the primary renderer's first push proves otherwise — a
  // capture window that accepts text it can never deliver is a lie.
  connected: false,
  draft: '',
  failure: null,
  sessions: [],
  submitting: false,
  target: QUICK_TARGET_CURRENT,
  visible: true
}

export function quickComposerReducer(state: QuickComposerState, event: QuickComposerEvent): QuickComposerTransition {
  switch (event.type) {
    case 'blur':
    case 'dismiss': {
      // Escape / focus loss discards without sending. A dismiss mid-submit still
      // hides — the send already left for the main process.
      return {
        send: null,
        state: { ...state, draft: '', failure: null, submitting: false, target: QUICK_TARGET_CURRENT, visible: false }
      }
    }

    case 'edit': {
      return { send: null, state: { ...state, draft: event.draft } }
    }

    case 'failed': {
      // hc-1113: a line that did not land comes back into the input, with why.
      return {
        send: null,
        state: { ...state, draft: event.failure.text, failure: event.failure, submitting: false, visible: true }
      }
    }

    case 'shown': {
      // Re-summoned: a fresh capture surface every time — never a stale draft or
      // a leftover target — but the pushed gateway truth carries over.
      return {
        send: null,
        state: { ...state, draft: '', failure: null, submitting: false, target: QUICK_TARGET_CURRENT, visible: true }
      }
    }

    case 'state': {
      // Adopt the pushed truth. A selected session that no longer exists in the
      // pushed list must not silently swallow the prompt — fall back to current.
      const targetStillValid =
        event.connected &&
        (state.target === QUICK_TARGET_CURRENT ||
          state.target === QUICK_TARGET_NEW ||
          event.sessions.some(session => session.id === state.target))

      return {
        send: null,
        state: {
          ...state,
          // A push that names none (one assistant, an older primary) leaves the name to localStorage.
          assistant: event.assistant,
          connected: event.connected,
          sessions: event.sessions,
          target: targetStillValid ? state.target : QUICK_TARGET_CURRENT
        }
      }
    }

    case 'submit': {
      const text = state.draft.trim()

      // Nothing to send — or nowhere to send it (gateway down): stay open and
      // keep the draft so a stray Enter can't make the text vanish.
      if (!text || state.submitting || !state.connected) {
        return { send: null, state }
      }

      // hc-1113: the line goes to the assistant the window named, not whichever is on screen when it lands.
      const assistant = state.assistant ? { assistant: state.assistant } : {}

      return {
        send: { target: state.target, text, ...assistant },
        state: { ...state, draft: '', failure: null, submitting: true, visible: false }
      }
    }

    case 'target': {
      return { send: null, state: { ...state, target: event.target } }
    }

    default: {
      return { send: null, state }
    }
  }
}

// ── Primary-renderer bridge ────────────────────────────────────────────────

type QuickEntrySubmitHandler = (payload: QuickEntrySubmitPayload) => Promise<QuickEntryDelivery>

let submitHandler: null | QuickEntrySubmitHandler = null
let unsubscribeSubmit: (() => void) | null = null

/**
 * Register the handler that turns a quick-window submit into a real send. The
 * primary window routes it by target: current chat → `submitText`, a stored
 * session id → resume + submit, new → fresh draft + submit. It resolves to what
 * became of the line, which goes back to main as the receipt (hc-1113).
 */
export function setQuickEntrySubmitHandler(fn: null | QuickEntrySubmitHandler): void {
  submitHandler = fn
}

function assistantRefOf(raw: unknown): null | QuickEntryAssistantRef {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null

  return record && typeof record.profile === 'string' && record.profile
    ? { name: typeof record.name === 'string' && record.name ? record.name : record.profile, profile: record.profile }
    : null
}

/** One line from main to its receipts: accepted at once, then delivered or failed (never silence). */
async function settleCapture(payload: QuickEntrySubmitPayload, api: QuickEntryDesktopApi): Promise<void> {
  // No id: an older main that does not wait for receipts.
  const id = payload.id ?? ''
  const receipt = (value: QuickEntryReceipt) => (id ? api.receipt?.(value) : undefined)

  receipt({ id, stage: 'accepted' })

  let outcome: QuickEntryDelivery

  try {
    outcome = submitHandler
      ? await submitHandler(payload)
      : { detail: 'no submit handler', ok: false, profile: null, reason: 'refused' }
  } catch (error) {
    outcome = {
      detail: error instanceof Error ? error.message : String(error),
      ok: false,
      profile: null,
      reason: 'error'
    }
  }

  if (outcome.ok) {
    receipt({ id, kind: outcome.kind, profile: outcome.profile, stage: 'delivered' })
  } else {
    receipt({ detail: outcome.detail, id, profile: outcome.profile, reason: outcome.reason, stage: 'failed' })
  }
}

function normalizeSubmitPayload(raw: unknown): null | QuickEntrySubmitPayload {
  // Tolerate the v1 bare-string wire shape (an older quick window after a
  // partial update) by treating it as "send to the current chat".
  if (typeof raw === 'string') {
    return raw.trim() ? { target: QUICK_TARGET_CURRENT, text: raw } : null
  }

  if (!raw || typeof raw !== 'object') {
    return null
  }

  const record = raw as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : ''

  if (!text.trim()) {
    return null
  }

  const assistant = assistantRefOf(record.assistant)

  return {
    target: typeof record.target === 'string' && record.target ? record.target : QUICK_TARGET_CURRENT,
    text,
    ...(assistant && { assistant }),
    ...(typeof record.id === 'string' && record.id && { id: record.id })
  }
}

/**
 * Wire the quick-window → primary-renderer submit channel once. Returns a
 * disposer. Idempotent — a second call while wired is a no-op.
 */
export function initQuickEntryBridge(): () => void {
  const api = typeof window === 'undefined' ? undefined : window.hermesDesktop?.quickEntry

  if (!api?.onSubmit || unsubscribeSubmit) {
    return () => {}
  }

  unsubscribeSubmit = api.onSubmit(raw => {
    const payload = normalizeSubmitPayload(raw)

    if (payload) {
      void settleCapture(payload, api)
    }
  })

  return () => {
    unsubscribeSubmit?.()
    unsubscribeSubmit = null
  }
}
