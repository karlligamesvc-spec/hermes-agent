/**
 * hc-1014 单线对话: where a Quick Entry capture goes. In single-thread product
 * mode every capture belongs in the one conversation, whatever the quick
 * window's picker said: into the thread on screen as the current chat, or in
 * the background through the session-tile path when the main window shows
 * something else. With no thread yet, a new chat is made and claimed as the
 * thread. Off, the picked target is returned unchanged.
 *
 * hc-1077: with several assistants on, the thread is the one on screen; a
 * capture made while a switch to another assistant has not landed yet waits
 * for it (holdUntilBotSwitchLands), so it never goes into the previous one's.
 */

import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { QUICK_TARGET_CURRENT, QUICK_TARGET_NEW } from '@/store/quick-entry'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { isSingleThreadMode } from '@/store/single-thread'
import { $currentBotProfile, isMultiBotMode } from '@/store/single-thread-bots'

import { $pendingThreadClaim } from './composer-middleware'

/** How long a capture waits for a switch to land before it goes where the app is (a stuck switch must not eat it). */
export const BOT_SWITCH_WAIT_MS = 30_000

/** The assistant asked for is not the one whose thread is on hand yet (or its thread is still being looked up). */
function botSwitchPending(): boolean {
  const current = $currentBotProfile.get()
  const thread = $mainThread.get()

  return (
    current !== normalizeProfileKey($activeGatewayProfile.get()) ||
    thread.profile !== current ||
    thread.status === 'loading'
  )
}

/**
 * With several assistants on and a switch still landing: call `deliver` once
 * it has (or after {@link BOT_SWITCH_WAIT_MS}) and return true. Otherwise
 * return false and the caller delivers now.
 */
export function holdUntilBotSwitchLands(deliver: () => void): boolean {
  if (!isMultiBotMode() || !botSwitchPending()) {
    return false
  }

  let done = false
  const stops: (() => void)[] = []

  const finish = () => {
    if (!done) {
      done = true
      window.clearTimeout(timer)
      stops.forEach(stop => stop())
      deliver()
    }
  }

  const check = () => {
    if (!botSwitchPending()) {
      finish()
    }
  }

  const timer = window.setTimeout(finish, BOT_SWITCH_WAIT_MS)

  stops.push($currentBotProfile.listen(check), $activeGatewayProfile.listen(check), $mainThread.listen(check))

  return true
}

export function singleThreadQuickEntryTarget(picked: string): string {
  if (!isSingleThreadMode()) {
    return picked
  }

  const thread = $mainThread.get()

  if (thread.status === 'absent') {
    $pendingThreadClaim.set({ at: Date.now(), profile: normalizeProfileKey($activeGatewayProfile.get()) })

    return QUICK_TARGET_NEW
  }

  if (thread.status !== 'found' || !thread.tipId) {
    return QUICK_TARGET_CURRENT
  }

  return isMainThreadStoredId($selectedStoredSessionId.get(), thread, $sessions.get())
    ? QUICK_TARGET_CURRENT
    : thread.tipId
}
