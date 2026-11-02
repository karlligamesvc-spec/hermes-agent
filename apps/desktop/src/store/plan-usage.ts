/**
 * hc-1061 G3: the plan and its usage for the single-thread sidebar's account row
 * (「快速 · 本月用了 18%」), read through main with the login JWT
 * (electron/apex-plan-usage.ts → apex-nodes GET /api/v1/account/plan-usage).
 *
 * Kept per account: a line read for one account is never shown for another.
 * A failed read keeps the last good line; no line at all (an older main, an
 * installer-only account, an older cloud, sign-in needed) shows the email.
 *
 * hc-1133: the same read fills the account menu's card (`weeklyQuotaView`,
 * `planTierOf`). It belongs to the account, whichever assistant is on screen.
 */

import { atom } from 'nanostores'

import type { DesktopPlanUsage } from '@/global'

import type { DesktopAuthState } from './auth'

/** The plans the plans page lists, by the code the cloud knows them by. */
export type PlanTier = 'free' | 'max' | 'pro'

const PLAN_TIER_BY_CODE: Readonly<Record<string, PlanTier>> = { advanced: 'max', fast: 'pro', free: 'free' }

/** Which listed plan a code is; null for anything else (`plus`, a code this build does not know). */
export function planTierOf(code: null | string | undefined): null | PlanTier {
  return (code && Object.hasOwn(PLAN_TIER_BY_CODE, code) && PLAN_TIER_BY_CODE[code]) || null
}

/** Which listed plan this account is on: the cloud's word, else the code the sign-in gave. */
export function accountPlanTier(usage: DesktopPlanUsage | null, accountPlan: string): null | PlanTier {
  return planTierOf(usage?.planCode ?? accountPlan)
}

/**
 * What the account menu says about this week.
 *
 * `limited` only when the cloud says calls are refused at the allowance
 * (`weekly.enforced`). The ledger runs in shadow first, recording and refusing
 * nothing, and its numbers look exactly like a limit: 「还剩 40%」 would be a
 * number about nothing. A cloud that says it enforces but gives no usable
 * numbers is `unknown`, never 「不限量」.
 */
export type WeeklyQuotaView =
  | { kind: 'limited'; remainingRatio: number; resetsAt: string; usedUp: boolean }
  | { kind: 'unknown' }
  | { kind: 'unlimited' }

export function weeklyQuotaView(usage: DesktopPlanUsage | null): WeeklyQuotaView {
  if (!usage) {
    return { kind: 'unknown' }
  }

  const weekly = usage.weekly

  if (!weekly?.enforced || weekly.unlimited) {
    return { kind: 'unlimited' }
  }

  if (weekly.usedRatio === null || !weekly.resetsAt) {
    return { kind: 'unknown' }
  }

  return {
    kind: 'limited',
    remainingRatio: Math.max(0, 1 - weekly.usedRatio),
    resetsAt: weekly.resetsAt,
    usedUp: weekly.usedRatio >= 1
  }
}

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
