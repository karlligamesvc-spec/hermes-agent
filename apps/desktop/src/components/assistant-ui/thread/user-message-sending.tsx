/**
 * hc-1101: 「仍在发送中」 under your latest message in single-thread product
 * mode, once the gateway has left the send untaken for 5 seconds (Muse says
 * "Still sending").
 *
 * "Taken" means the prompt submit's per-session hold is gone
 * (store/submits-in-flight.ts):
 * - `prompt.submit` came back;
 * - it failed (the error card then says so);
 * - the hold expired.
 *
 * Only the latest user message gets the note, and only when it was sent after
 * the hold was taken. While a new conversation is still being created, that
 * message is not on screen yet, so an older one never shows it. Anywhere else
 * this renders nothing.
 */

import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useSingleThreadMessageCopy } from '@/i18n/single-thread-messages'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { useSingleThreadMode } from '@/store/single-thread'
import { $submitsInFlight } from '@/store/submits-in-flight'

export const STILL_SENDING_AFTER_MS = 5_000

// A new conversation's send holds this key until its session exists (submit.ts submitLockKey).
const NEW_CONVERSATION_KEY = '__pending_new__'

/** When the hold behind this message was taken (epoch ms), or undefined when it is not waiting on one. */
function useHeldSince(): number | undefined {
  const singleThread = useSingleThreadMode()
  const holds = useStore($submitsInFlight)
  const stored = useStore($selectedStoredSessionId)
  const active = useStore($activeSessionId)

  const sentAt = useAuiState(s => {
    const latestUser = s.thread.messages.findLast(message => message.role === 'user')

    return singleThread && latestUser?.id === s.message.id && s.message.createdAt instanceof Date
      ? s.message.createdAt.getTime()
      : null
  })

  if (sentAt === null) {
    return undefined
  }

  const held = [stored, active, NEW_CONVERSATION_KEY].map(key => (key ? holds.get(key) : undefined))
  const since = held.find((at): at is number => at !== undefined)

  // The bubble is added after the hold is taken; a second's slack covers rounding.
  return since !== undefined && sentAt >= since - 1_000 ? since : undefined
}

export function UserMessageSendingNote() {
  const copy = useSingleThreadMessageCopy()
  const since = useHeldSince()
  const [, setTick] = useState(0)

  useEffect(() => {
    if (since === undefined) {
      return
    }

    const wait = since + STILL_SENDING_AFTER_MS - Date.now()

    if (wait <= 0) {
      return
    }

    const timer = window.setTimeout(() => setTick(tick => tick + 1), wait)

    return () => window.clearTimeout(timer)
  }, [since])

  if (since === undefined || Date.now() - since < STILL_SENDING_AFTER_MS) {
    return null
  }

  return (
    <p
      className="self-end px-1.5 pt-1 text-[0.75rem] leading-4 text-(--ui-text-tertiary)"
      data-still-sending=""
      role="status"
    >
      {copy.stillSending}
    </p>
  )
}
