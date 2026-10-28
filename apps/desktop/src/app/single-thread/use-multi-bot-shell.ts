/**
 * hc-1077 多助手第一期 M1: the shell's part while several assistants are on
 * (store/single-thread-bots.ts), mounted by useSingleThreadShell. It
 *
 * - reads the roster once the gateway is open, on every assistant switch and
 *   every {@link ROSTER_REFRESH_MS} (a name the engine changed, an assistant
 *   made or deleted elsewhere);
 * - looks up the thread of every assistant not on screen, so its row can
 *   follow it while it works in the background;
 * - follows a conversation to its assistant: when the conversation on screen
 *   is another assistant's thread (a notification, the command palette), that
 *   assistant comes on screen, so its thread is never shown as somebody's
 *   「更早的对话」. Once per selection: a switch that does not land is not
 *   retried in a loop;
 * - tells the quick-entry window which assistant a capture will reach, and
 *   names the assistant in system notifications (bot-notifications.ts).
 *
 * Off (or in a pop-out window) it does nothing.
 */

import { useStore } from '@nanostores/react'
import { type MutableRefObject, useEffect, useRef } from 'react'

import { rememberQuickEntryAssistant } from '@/i18n/quick-entry'
import { botNotificationTitle } from '@/store/bot-notifications'
import { $mainThreadsByProfile, resolveProfileThread } from '@/store/main-thread'
import { setNotificationTitleNamer } from '@/store/notification-title'
import { $selectedStoredSessionId } from '@/store/session'
import {
  $botSwitchInFlight,
  $currentBot,
  $currentBotProfile,
  $multiBotMode,
  loadMultiBotFlag,
  openBot,
  refreshBotRoster
} from '@/store/single-thread-bots'
import { profileOfThreadStoredId } from '@/store/single-thread-presence'

import type { RequestGateway } from './composer-middleware'

export const ROSTER_REFRESH_MS = 20_000

async function refreshRosterAndThreads(request: RequestGateway, activeProfile: string): Promise<void> {
  const roster = await refreshBotRoster(request)
  const held = $mainThreadsByProfile.get()

  await Promise.all(
    roster
      .filter(bot => bot.profile !== activeProfile && held[bot.profile]?.status !== 'found')
      .map(bot => resolveProfileThread(request, bot.profile))
  )
}

/** Is several-assistants mode on for this shell, and is an assistant switch still settling? */
export function useMultiBotShell(
  enabled: boolean,
  gatewayOpen: boolean,
  profile: string,
  requestRef: MutableRefObject<RequestGateway>
): { multiBot: boolean; switching: boolean } {
  const multiBot = useStore($multiBotMode) && enabled
  const current = useStore($currentBotProfile)
  const selected = useStore($selectedStoredSessionId)
  const threads = useStore($mainThreadsByProfile)
  const currentName = useStore($currentBot)?.name ?? null
  // hc-1099: a switch under way, even one whose engine is already published as the active profile.
  const settling = useStore($botSwitchInFlight)
  // The assistant asked for is not the one answering yet: nothing may open the old one's thread meanwhile.
  const switching = multiBot && current !== profile
  const followed = useRef<null | string>(null)

  useEffect(() => {
    void loadMultiBotFlag()
  }, [])

  useEffect(() => {
    rememberQuickEntryAssistant(multiBot ? currentName : null)
  }, [currentName, multiBot])

  useEffect(() => {
    setNotificationTitleNamer(multiBot ? botNotificationTitle : null)

    return () => setNotificationTitleNamer(null)
  }, [multiBot])

  useEffect(() => {
    if (!multiBot || !gatewayOpen) {
      return
    }

    const refresh = () => void refreshRosterAndThreads(requestRef.current, profile).catch(() => undefined)

    refresh()
    const timer = window.setInterval(refresh, ROSTER_REFRESH_MS)

    return () => window.clearInterval(timer)
  }, [gatewayOpen, multiBot, profile, requestRef])

  // A marker of what was already tried, not a mirror of an atom.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    // Not while any switch is under way (hc-1099): until it settles, the conversation on screen
    // can be the one being left, and following it would switch straight back. Re-checked after.
    if (!multiBot || switching || settling) {
      return
    }

    const owner = profileOfThreadStoredId(selected)

    if (!owner || owner === profile) {
      followed.current = null

      return
    }

    if (followed.current !== selected) {
      followed.current = selected
      void openBot(owner, 'follow').catch(() => undefined)
    }
  }, [multiBot, profile, selected, settling, switching, threads])

  return { multiBot, switching }
}
