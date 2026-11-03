/**
 * hc-1133: who is signed in, as the account row, the account menu and Settings ›
 * 账号 all show it. Always the account in `$authState`, never the assistant on
 * screen: with several assistants on, each has its own name and look, and none
 * of them is the account.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { knownPlanName, useAccountMenuCopy } from '@/i18n/account-menu'
import { profileColor } from '@/lib/profile-color'
import { $authState, type AuthAccount } from '@/store/auth'
import { $planUsage, planUsageFor, planUsageOwner, refreshPlanUsage } from '@/store/plan-usage'
import { useSingleThreadMode } from '@/store/single-thread'

/** The same name AccountPanel shows: an explicit name, else the email's local part, else 「账户」. */
export function accountDisplayName(account: AuthAccount, fallback: string): string {
  return account.name || (account.email ? account.email.split('@')[0] || account.email : '') || fallback
}

/** The account's plan usage, read when the page opens (if `read`); null until there is a line to show. */
export function useAccountPlanUsage(read = true) {
  const auth = useStore($authState)
  const owner = planUsageOwner(auth)
  const signedIn = auth.status === 'signed-in'

  useEffect(() => {
    if (read && signedIn) {
      void refreshPlanUsage(owner)
    }
  }, [owner, read, signedIn])

  return { auth, usage: planUsageFor(useStore($planUsage), owner) }
}

/**
 * What 个人资料 says about the plan. Product mode names it the way the account menu
 * does and reads the account's line for that; empty when nothing names it. Developer
 * mode and switch off keep what they always showed, the code the sign-in gave.
 */
export function useProfilePlan(): string {
  const productMode = useSingleThreadMode()
  const copy = useAccountMenuCopy()
  const { auth, usage } = useAccountPlanUsage(productMode)

  return productMode ? knownPlanName(usage, auth.account.plan, copy) : auth.account.plan.trim()
}

function initialOf(name: string): string {
  return (name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0) || '?').toUpperCase()
}

export function AccountAvatar({
  account,
  name,
  size = 'size-7'
}: {
  account: AuthAccount
  name: string
  size?: 'size-7' | 'size-9'
}) {
  return (
    <span
      aria-hidden
      className={`grid ${size} shrink-0 place-items-center rounded-full text-xs font-semibold uppercase leading-none text-white`}
      data-apex-account-avatar=""
      style={{ backgroundColor: profileColor(account.email || name) ?? 'var(--theme-primary)' }}
    >
      {initialOf(name)}
    </span>
  )
}
