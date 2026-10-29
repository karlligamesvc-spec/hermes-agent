import { atom } from 'nanostores'

import { dismissNotification } from '@/store/notifications'

/**
 * hc-1110: a sign-in asked for while the account is still signed in, or only
 * expired: the account menus' 「重新登录」, the 「登录已失效」 cards, a send the
 * relay refused, the IM binding and a failed sign-out. The auth gate answers it
 * with the first-open sign-in screen, drawn over the app, so a finished sign-in
 * (or 「返回」) leaves the user where they were. `notice` is the line above the
 * buttons; null shows none, like a first open.
 */
export interface ManagedReSignInRequest {
  notice: null | string
}

export const $managedReSignIn = atom<ManagedReSignInRequest | null>(null)

export function openManagedReSignIn(notice: string): void {
  $managedReSignIn.set({ notice: notice.trim() || null })
}

export function closeManagedReSignIn(): void {
  $managedReSignIn.set(null)
}

/** The 「需要重新登录」 toast a refused send leaves under the screen (store/managed-recovery.ts). */
export const RE_SIGN_IN_TOAST_ID = 'managed-relay-signin'

/** A finished sign-in answers the request and that toast, so the user comes back to a clean screen. */
export function finishManagedReSignIn(): void {
  closeManagedReSignIn()
  dismissNotification(RE_SIGN_IN_TOAST_ID)
}
