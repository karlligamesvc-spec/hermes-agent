/**
 * hc-1133: who is signed in, as the account row, the account menu and Settings ›
 * 账号 all show it. Always the account in `$authState`, never the assistant on
 * screen: with several assistants on, each has its own name and look, and none
 * of them is the account.
 */

import { profileColor } from '@/lib/profile-color'
import type { AuthAccount } from '@/store/auth'

/** The same name AccountPanel shows: an explicit name, else the email's local part, else 「账户」. */
export function accountDisplayName(account: AuthAccount, fallback: string): string {
  return account.name || (account.email ? account.email.split('@')[0] || account.email : '') || fallback
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
