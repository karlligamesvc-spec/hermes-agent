/**
 * hc-1146 发消息半天没反应: sends the messages held while an assistant's
 * conversation was opening (store/held-sends.ts), mounted by the single-thread
 * shell while several assistants are on.
 *
 * - Only the assistant on screen sends, and only once its thread can take a
 *   send: the same rule the composer middleware uses to hold it
 *   (composer-middleware.ts sendPlace), so the two never disagree.
 * - One at a time, oldest first: the next waits until the reply to the one
 *   before has finished, as a queued message does.
 * - Each goes through the composer's middleware chain and the app's submit as
 *   if it had been sent at that moment, and is taken out of the line before
 *   that starts, so it goes out once.
 * - A send the app refuses comes back into the composer (as a refused send
 *   always did), never silently lost; a send that lost a race with another
 *   turn just waits for it.
 * - A thread lookup that failed opens nothing by itself: the held messages
 *   come back into the composer with the notice a send got then.
 * - An assistant that is deleted takes its held messages with it.
 *
 * Off (one assistant, developer mode, a pop-out window) it does nothing.
 */

import { type MutableRefObject, useEffect } from 'react'

import { COMPOSER_SEND_DONE, COMPOSER_SEND_TAKEN, runComposerMiddleware } from '@/app/chat/composer/contrib'
import { requestComposerInsert } from '@/app/chat/composer/focus'
import { singleThreadChatCopyNow } from '@/i18n/single-thread-chat'
import { type ComposerAttachment, mainComposerScope } from '@/store/composer'
import { $heldSends, dropHeldSendsOutside, type HeldSend, heldSendsFor, rehold, takeHeldSend } from '@/store/held-sends'
import { $mainThread } from '@/store/main-thread'
import { notify } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeSessionId, $busy, $gatewayState, $selectedStoredSessionId, $sessions } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { $botRoster, $currentBotProfile, isMultiBotMode } from '@/store/single-thread-bots'

import { sendPlace } from './composer-middleware'

/** The app's submit (use-prompt-actions submitText): false when it refused the send. */
export type HeldSendSubmit = (
  text: string,
  options: { attachments: ComposerAttachment[] }
) => Promise<unknown> | unknown

/** A turn is running in the conversation on screen, or still settling. */
function turnRunning(): boolean {
  const runtimeId = $activeSessionId.get()

  return $busy.get() || Boolean(runtimeId && $sessionStates.get()[runtimeId]?.turnLive)
}

/** Can the assistant on screen take its next held message now? */
export function heldSendReady(): boolean {
  if ($gatewayState.get() !== 'open' || turnRunning()) {
    return false
  }

  const place = sendPlace(normalizeProfileKey($activeGatewayProfile.get()))

  return place === 'thread' || place === 'new'
}

/** Words that could not go out go back into the composer, after whatever is typed there now. */
export function returnHeldToComposer(held: HeldSend): void {
  requestComposerInsert(held.text, { mode: 'block', target: 'main' })

  for (const attachment of held.attachments) {
    mainComposerScope.add(attachment)
  }
}

/** The user took a waiting message back: it is not sent, and its words go back into the composer. */
export function withdrawHeldSend(id: string): void {
  const held = takeHeldSend(id)

  if (held) {
    returnHeldToComposer(held)
  }
}

let releasing = false

/** Send the on-screen assistant's oldest held message if it can go now. Resolves whether one went out. */
export async function releaseNextHeldSend(submit: HeldSendSubmit): Promise<boolean> {
  if (releasing || !isMultiBotMode()) {
    return false
  }

  const held = heldSendsFor($heldSends.get(), $currentBotProfile.get())
  const next = held[0]

  if (
    next &&
    $gatewayState.get() === 'open' &&
    sendPlace(normalizeProfileKey($activeGatewayProfile.get())) === 'unavailable'
  ) {
    for (const item of held) {
      takeHeldSend(item.id)
      returnHeldToComposer(item)
    }

    notify({ kind: 'info', message: singleThreadChatCopyNow().threadUnavailable })

    return false
  }

  if (!next || !heldSendReady()) {
    return false
  }

  releasing = true
  takeHeldSend(next.id)

  try {
    const draft = await runComposerMiddleware({ text: next.text, attachments: [...next.attachments] })

    // hc-1226: a command the middleware carried out (`/new`) went out; it does not come back.
    if (draft === COMPOSER_SEND_DONE) {
      return true
    }

    // The thread started opening again in between: the middleware has held it once more.
    if (draft === COMPOSER_SEND_TAKEN) {
      return false
    }

    // Refused on the way (each refusal says why): back into the composer, as a refused send.
    if (draft === null) {
      returnHeldToComposer(next)

      return false
    }

    if ((await submit(draft.text, { attachments: draft.attachments ?? [] })) === false) {
      if (turnRunning()) {
        rehold(next)
      } else {
        returnHeldToComposer(next)
      }

      return false
    }

    return true
  } catch {
    returnHeldToComposer(next)

    return false
  } finally {
    releasing = false
  }
}

/**
 * Watch what decides whether a held message can go (the assistant on screen,
 * its thread, the conversation, a turn, the gateway) and send them in turn.
 * `submitRef` is read at send time, so it always reaches the live submit.
 */
export function useHeldSendRelease(enabled: boolean, submitRef: MutableRefObject<HeldSendSubmit | null>): void {
  useEffect(() => {
    if (!enabled) {
      return
    }

    let scheduled = false
    let stopped = false

    const pump = () => {
      if (scheduled || stopped) {
        return
      }

      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const submit = submitRef.current

        if (!stopped && submit) {
          void releaseNextHeldSend(submit).then(sent => sent && pump())
        }
      })
    }

    const stops = [
      $heldSends.listen(pump),
      $currentBotProfile.listen(pump),
      $activeGatewayProfile.listen(pump),
      $mainThread.listen(pump),
      $selectedStoredSessionId.listen(pump),
      $activeSessionId.listen(pump),
      $sessions.listen(pump),
      $busy.listen(pump),
      $sessionStates.listen(pump),
      $gatewayState.listen(pump),
      $botRoster.listen(roster => {
        if (roster.length > 0) {
          dropHeldSendsOutside(new Set(roster.map(bot => bot.profile)))
        }
      })
    ]

    pump()

    return () => {
      stopped = true
      stops.forEach(stop => stop())
    }
  }, [enabled, submitRef])
}
