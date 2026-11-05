/**
 * hc-1146 启动时预热: with several assistants on, this window remembers which
 * assistant was on screen last and, on the next launch, starts that
 * assistant's engine in the background as soon as the main engine answers —
 * before anyone clicks it — so opening it then is a warm switch instead of a
 * cold one. The name is written once, when the window goes away (quit, close,
 * reload), so switching itself writes nothing.
 *
 * Only the engine starts. The screen still opens where it always did (the
 * startup profile, hc-1115/K7), nothing is resumed and nothing is sent; the
 * spawn goes through prewarmProfileBackend (store/profile.ts), the same guard
 * every speculative warm in the app uses: never past the pool's cap, never for
 * the engine already answering, at most once a minute per profile.
 *
 * Waits for the main engine on purpose: right after an update that one first
 * installs the new runtime, and a pool engine must not start before it.
 *
 * Off (one assistant, developer mode, a pop-out window) it does nothing.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { readKey, writeKey } from '@/lib/storage'
import { $activeGatewayProfile, normalizeProfileKey, prewarmProfileBackend } from '@/store/profile'
import { $botRoster, $botSwitchInFlight, $currentBotProfile } from '@/store/single-thread-bots'

/** localStorage: the profile of the assistant on screen when a switch last settled. */
export const LAST_ASSISTANT_KEY = 'apex.single-thread.bots.last-on-screen.v1'

/** The assistant to warm at launch: the last one on screen, when it still exists and is not the one answering. */
export function startupPrewarmTarget(
  last: null | string,
  active: string,
  roster: readonly { profile: string }[]
): null | string {
  const target = last ? normalizeProfileKey(last) : null

  if (!target || target === normalizeProfileKey(active) || !roster.some(bot => bot.profile === target)) {
    return null
  }

  return target
}

export function useStartupPrewarm(multiBot: boolean, gatewayOpen: boolean): void {
  // Read once, before this launch's own assistant on screen is remembered over it.
  const [launchLast] = useState(() => readKey(LAST_ASSISTANT_KEY))
  const current = useStore($currentBotProfile)
  const settling = useStore($botSwitchInFlight)
  const warmed = useRef(false)
  // The assistant on screen once its switch settled; written when the window goes away (quit, close, reload).
  const onScreen = useRef<null | string>(null)

  // A marker of what to remember, not a mirror of an atom.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (multiBot && gatewayOpen && !settling) {
      onScreen.current = current
    }
  }, [current, gatewayOpen, multiBot, settling])

  useEffect(() => {
    if (!multiBot) {
      return
    }

    const remember = () => {
      if (onScreen.current && readKey(LAST_ASSISTANT_KEY) !== onScreen.current) {
        writeKey(LAST_ASSISTANT_KEY, onScreen.current)
      }
    }

    window.addEventListener('pagehide', remember)

    return () => window.removeEventListener('pagehide', remember)
  }, [multiBot])

  // A marker that this launch's warm has run, not a mirror of an atom.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!multiBot || !gatewayOpen || warmed.current) {
      return
    }

    warmed.current = true
    const target = startupPrewarmTarget(launchLast, $activeGatewayProfile.get(), $botRoster.get())

    if (target) {
      prewarmProfileBackend(target)
    }
  }, [gatewayOpen, launchLast, multiBot])
}
