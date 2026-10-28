/**
 * hc-1061 G3: the plan and its usage for the single-thread sidebar's account row
 * (「快速 · 本月用了 18%」), read through main with the login JWT
 * (electron/apex-plan-usage.ts → apex-nodes GET /api/v1/account/plan-usage).
 *
 * Kept per account: a line read for one account is never shown for another.
 * A failed read keeps the last good line; no line at all (an older main, an
 * installer-only account, an older cloud, sign-in needed) shows the email.
 */

import { atom } from 'nanostores'

import type { DesktopPlanUsage } from '@/global'

import type { DesktopAuthState } from './auth'

export interface AccountPlanUsage {
  accountId: string
  usage: DesktopPlanUsage | null
}

export const $planUsage = atom<AccountPlanUsage | null>(null)

let serial = 0

export async function refreshPlanUsage(accountId: string): Promise<void> {
  const read = typeof window !== 'undefined' ? window.hermesDesktop?.managed?.planUsage : undefined

  if (!read) {
    return
  }

  const mine = ++serial

  try {
    const result = await read()

    if (mine !== serial) {
      return
    }

    if (result.ok || result.needsSignIn) {
      $planUsage.set({ accountId, usage: result.ok ? result.usage : null })
    }
  } catch {
    // Keep the last good line: a broken bridge is not the plan going away.
  }
}

/** Whose usage line: the account id, else the email, else 「managed」 (the sidebar row and the relay card read the same one). */
export function planUsageOwner(auth: Pick<DesktopAuthState, 'account' | 'accountId'>): string {
  return auth.accountId || auth.account.email || 'managed'
}

/** Has this account been read yet (whatever the answer was)? */
export function planUsageReadFor(accountId: string): boolean {
  return $planUsage.get()?.accountId === accountId
}

/** The usage line for this account, or null when there is none to show. */
export function planUsageFor(state: AccountPlanUsage | null, accountId: string): DesktopPlanUsage | null {
  return state && state.accountId === accountId ? state.usage : null
}
