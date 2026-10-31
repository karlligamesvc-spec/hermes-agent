import { useEffect, useRef } from 'react'

import { deliverQuickCapture } from '@/app/quick-entry/deliver'
import { useI18n } from '@/i18n'
import { rememberQuickEntryLocale } from '@/i18n/quick-entry'
import {
  initQuickEntryBridge,
  type QuickEntryAssistantRef,
  type QuickEntrySessionOption,
  setQuickEntrySubmitHandler
} from '@/store/quick-entry'
import { $gatewayState, $sessions } from '@/store/session'
import { $currentBot } from '@/store/single-thread-bots'
import { isAuxiliaryWindow } from '@/store/windows'

interface QuickEntryBridgeParams {
  startFreshSessionDraft: () => void
  submitText: (text: string) => Promise<unknown> | unknown
}

// The picker is a capture aid, not a session browser — a handful of recent
// rows is the whole point.
const QUICK_ENTRY_SESSION_OPTIONS = 5

function sessionOptions(): QuickEntrySessionOption[] {
  return $sessions
    .get()
    .filter(session => !session.archived)
    .slice(0, QUICK_ENTRY_SESSION_OPTIONS)
    .map(session => ({
      id: session.id,
      // Empty when the session has neither: the quick window names it in its
      // own language. The raw id used to stand in, a code string in a menu.
      title: session.title?.trim() || session.preview?.trim() || ''
    }))
}

/** hc-1113: the assistant on screen while several are on (the quick window names it and its lines go there); nothing with one. */
function assistantOnScreen(): { assistant?: QuickEntryAssistantRef } {
  const bot = $currentBot.get()

  return bot ? { assistant: { name: bot.name, profile: bot.profile } } : {}
}

/**
 * Wires the global-hotkey Quick Entry window back into the app, both ways:
 *
 * - **Inbound:** text captured there is routed by target and submitted through
 *   THIS window's normal prompt machinery — current chat rides `submitText`, a
 *   picked stored session rides the session-tile delegate (resume + submit,
 *   background, without touching the primary view — the same path tiled
 *   sessions use), and "new session" is a fresh draft + submit, exactly what
 *   clicking New Chat and typing does. One submit pipeline, no bespoke RPC.
 * - **Outbound:** gateway connection state + the recent-session list are pushed
 *   to the quick window (via main, which caches the latest push), so its input
 *   disables with a reconnect hint whenever the backend is unreachable. With
 *   several assistants on, the push also names the one on screen, and main
 *   hands it over on every summon (hc-1113). The language this window resolved
 *   goes through localStorage instead (hc-1001), so the quick window has it on
 *   its first paint.
 *
 * Handlers register ONCE through refs tracking the latest callbacks —
 * re-registering on identity churn leaves a nulled-handler window that can drop
 * a submit (the same bug shape use-pet-bridge guards). Primary window only: a
 * secondary session window must not also claim the global capture channel, or
 * one keystroke would send N prompts.
 */
export function useQuickEntryBridge({ startFreshSessionDraft, submitText }: QuickEntryBridgeParams): void {
  const submitTextRef = useRef(submitText)
  submitTextRef.current = submitText
  const startFreshRef = useRef(startFreshSessionDraft)
  startFreshRef.current = startFreshSessionDraft
  const { locale } = useI18n()

  useEffect(() => {
    if (!isAuxiliaryWindow()) {
      rememberQuickEntryLocale(locale)
    }
  }, [locale])

  useEffect(() => {
    if (isAuxiliaryWindow()) {
      return
    }

    // hc-1113: routing and its outcome live in deliverQuickCapture; the outcome becomes main's receipt.
    setQuickEntrySubmitHandler(capture =>
      deliverQuickCapture(capture, {
        startFreshSessionDraft: () => startFreshRef.current(),
        submitText: text => submitTextRef.current(text)
      })
    )

    const dispose = initQuickEntryBridge()

    return () => {
      setQuickEntrySubmitHandler(null)
      dispose()
    }
  }, [])

  // Push gateway truth into the quick window whenever it changes: connection
  // state gates its input; the recent-session list feeds its target picker.
  useEffect(() => {
    if (isAuxiliaryWindow()) {
      return
    }

    const api = window.hermesDesktop?.quickEntry

    if (!api?.pushState) {
      return
    }

    const push = () => {
      api.pushState({ connected: $gatewayState.get() === 'open', sessions: sessionOptions(), ...assistantOnScreen() })
    }

    push()

    const offGateway = $gatewayState.listen(push)
    const offSessions = $sessions.listen(push)
    const offAssistant = $currentBot.listen(push)

    return () => {
      offGateway()
      offSessions()
      offAssistant()
    }
  }, [])
}
