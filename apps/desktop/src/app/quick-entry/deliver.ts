/**
 * hc-1113: what the main window does with a Quick Entry line, and what it
 * reports back. store/quick-entry turns the result into the receipt main logs
 * (electron/quick-entry-relay.ts); a failure goes back into the quick window.
 *
 * - With several assistants on, the line is for the assistant the quick window
 *   named. If another one is on screen by now, that one is opened first; a
 *   switch still landing is waited for (BOT_SWITCH_WAIT_MS). One that does not
 *   land is a failure, so the line never drops into someone else's thread.
 * - The target (in single-thread mode always the one conversation) then gets it
 *   through the same submit the composer uses. A send the app refuses — a turn
 *   still running, onboarding first, a read-only transcript — is a failure, not
 *   silence.
 */

import { botSwitchSettled, singleThreadQuickEntryTarget } from '@/app/single-thread/quick-entry'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import {
  QUICK_TARGET_CURRENT,
  QUICK_TARGET_NEW,
  type QuickEntryDelivery,
  type QuickEntryFailureReason,
  type QuickEntrySubmitPayload
} from '@/store/quick-entry'
import { $busy } from '@/store/session'
import { sessionTileDelegate } from '@/store/session-states'
import { $currentBotProfile, isMultiBotMode, openBot } from '@/store/single-thread-bots'

export interface QuickEntryDeliverDeps {
  startFreshSessionDraft: () => void
  /** The composer's submit: false when the app refused the send. */
  submitText: (text: string) => Promise<unknown> | unknown
}

function failed(reason: QuickEntryFailureReason, profile: null | string, detail: string): QuickEntryDelivery {
  return { detail, ok: false, profile, reason }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function deliverQuickCapture(
  capture: QuickEntrySubmitPayload,
  deps: QuickEntryDeliverDeps
): Promise<QuickEntryDelivery> {
  const wanted = isMultiBotMode() && capture.assistant ? normalizeProfileKey(capture.assistant.profile) : null

  if (wanted && wanted !== $currentBotProfile.get()) {
    try {
      await openBot(wanted)
    } catch (error) {
      return failed('switch', wanted, errorText(error))
    }
  }

  if (!(await botSwitchSettled(wanted))) {
    return failed('switch', wanted, 'the assistant was not on hand in time')
  }

  const profile = normalizeProfileKey($activeGatewayProfile.get())
  const target = singleThreadQuickEntryTarget(capture.target)

  const send = async (kind: 'current' | 'new'): Promise<QuickEntryDelivery> => {
    // Read before the send: a refused send leaves it as it was, a sent one sets it.
    const busy = $busy.get()

    if ((await deps.submitText(capture.text)) !== false) {
      return { kind, ok: true, profile }
    }

    return busy
      ? failed('busy', profile, 'a turn is still running')
      : failed('refused', profile, 'the app did not send it')
  }

  if (target === QUICK_TARGET_NEW) {
    // Same as the user clicking New Chat and typing: fresh draft, then the
    // normal submit creates the backend session.
    deps.startFreshSessionDraft()

    return send('new')
  }

  if (target !== QUICK_TARGET_CURRENT) {
    // A picked stored session: resume + submit in the background through
    // the session-tile delegate so the primary view stays where it is.
    const delegate = sessionTileDelegate()

    if (delegate) {
      try {
        const runtimeId = await delegate.resumeTile(target)
        await delegate.submitToSession(runtimeId, capture.text)

        return { kind: 'session', ok: true, profile }
      } catch {
        // A dead/undeliverable target must not swallow the prompt: the chat on screen takes it.
      }
    }
  }

  return send('current')
}
