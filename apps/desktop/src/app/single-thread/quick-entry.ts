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
 * for it (botSwitchSettled), so it never goes into the previous one's.
 * hc-1113: one that never lands ends the wait as a failure the quick window
 * shows (app/quick-entry/deliver.ts), instead of waiting again and again.
 */

import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { QUICK_TARGET_CURRENT, QUICK_TARGET_NEW } from '@/store/quick-entry'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { isSingleThreadMode } from '@/store/single-thread'
import { $currentBotProfile, isMultiBotMode } from '@/store/single-thread-bots'

import { $pendingThreadClaim } from './composer-middleware'

/** How long a capture waits for a switch to land before it is handed back as not delivered. */
export const BOT_SWITCH_WAIT_MS = 30_000

/** The assistant asked for is not the one whose thread is on hand yet (or its thread is still being looked up). */
function botSwitchPending(wanted: null | string): boolean {
  const current = $currentBotProfile.get()
  const thread = $mainThread.get()

  return (
    (wanted !== null && current !== wanted) ||
    current !== normalizeProfileKey($activeGatewayProfile.get()) ||
    thread.profile !== current ||
    thread.status === 'loading'
  )
}

/**
 * With several assistants on: resolves true once `wanted` (a profile key, or
 * null for whichever was asked for last) is the assistant answering and its
 * thread is on hand, false if that has not happened after `timeoutMs`. With
 * one assistant it resolves true at once.
 */
export function botSwitchSettled(wanted: null | string, timeoutMs = BOT_SWITCH_WAIT_MS): Promise<boolean> {
  if (!isMultiBotMode() || !botSwitchPending(wanted)) {
    return Promise.resolve(true)
  }

  return new Promise(resolve => {
    let done = false
    const stops: (() => void)[] = []

    const finish = (landed: boolean) => {
      if (!done) {
        done = true
        window.clearTimeout(timer)
        stops.forEach(stop => stop())
        resolve(landed)
      }
    }

    const check = () => {
      if (!botSwitchPending(wanted)) {
        finish(true)
      }
    }

    const timer = window.setTimeout(() => finish(false), timeoutMs)

    stops.push($currentBotProfile.listen(check), $activeGatewayProfile.listen(check), $mainThread.listen(check))
  })
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
