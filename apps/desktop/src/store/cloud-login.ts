/**
 * hc-1073: has the cloud rejected the stored login JWT? A thin mirror of main's
 * electron/apex-cloud-login.ts.
 *
 * Chat runs on the relay key and keeps working when the login JWT dies, but
 * platform skills and plugins stop updating (they are pulled with the JWT) until
 * the user signs in again. While this is true the sidebar shows a 「登录已失效」
 * card above the account row (app/chat/sidebar/cloud-login-notice.tsx).
 */

import { atom } from 'nanostores'

import type { DesktopCloudLoginState } from '@/global'

export const $cloudLoginRejected = atom(false)

// One IPC listener per window, however often the sidebar remounts.
let subscribed = false
// A push that lands while a read is in flight is newer than that read's answer.
let readGeneration = 0

function managedBridge() {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.managed
}

function apply(state: DesktopCloudLoginState | null | undefined) {
  $cloudLoginRejected.set(state?.rejected === true)
}

/** Read main's current state (after a sign-in, an account change, a remount). */
export async function refreshCloudLogin(): Promise<void> {
  const managed = managedBridge()

  if (!managed?.cloudLogin) {
    return
  }

  const generation = ++readGeneration

  try {
    const state = await managed.cloudLogin()

    if (generation === readGeneration) {
      apply(state)
    }
  } catch {
    // Keep the last known state; the next push or read settles it.
  }
}

/** Follow main's pushes (idempotent), and read the current state. */
export function watchCloudLogin(): void {
  const managed = managedBridge()

  if (!subscribed && managed?.onCloudLogin) {
    subscribed = true
    managed.onCloudLogin(state => {
      readGeneration += 1
      apply(state)
    })
  }

  void refreshCloudLogin()
}

/** Tests only: forget the listener and the state between renders. */
export function resetCloudLoginForTests(): void {
  subscribed = false
  readGeneration = 0
  $cloudLoginRejected.set(false)
}
