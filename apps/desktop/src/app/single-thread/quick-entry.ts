/**
 * hc-1014 单线对话: where a Quick Entry capture goes. In single-thread product
 * mode every capture belongs in the one conversation, whatever the quick
 * window's picker said: into the thread on screen as the current chat, or in
 * the background through the session-tile path when the main window shows
 * something else. With no thread yet, a new chat is made and claimed as the
 * thread. Off, the picked target is returned unchanged.
 */

import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { QUICK_TARGET_CURRENT, QUICK_TARGET_NEW } from '@/store/quick-entry'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { isSingleThreadMode } from '@/store/single-thread'

import { $pendingThreadClaim } from './composer-middleware'

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
