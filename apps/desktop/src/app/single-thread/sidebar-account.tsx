/**
 * hc-1061 G3: the single-thread sidebar's account row, as prototype v2 draws it:
 * the name over 「快速 · 本月用了 18%」 (hc-1062), falling back to the email
 * when the cloud gives no usage line.
 *
 * AccountPanel stays as it is for every other mode (its account-menu golden is
 * pinned), so this row carries its own copy of the menu: the same destinations
 * in the same order. hc-1070: 「沉浸式分析」 is not one of them; single-thread
 * mode has no analysis workspace. sidebar.test.tsx compares the two menus item
 * by item so they cannot drift apart. A session that is not signed in, or has expired, gets
 * AccountPanel itself: its sign-in recovery card is the one to show.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { useAccountTeamCopy } from '@/i18n/account-team'
import { formatUsedPercent, useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { profileColor } from '@/lib/profile-color'
import { cn } from '@/lib/utils'
import { $accountTeam, loadAccountTeam, teamFor } from '@/store/account-team'
import { $authState, type AuthAccount, captureManagedAuthRecoveryScope, signOutAccount } from '@/store/auth'
import { notify } from '@/store/notifications'
import { requestManagedReSignIn } from '@/store/onboarding'
import { $planUsage, planUsageFor, planUsageReadFor, refreshPlanUsage } from '@/store/plan-usage'
import { $threadPresence } from '@/store/single-thread-presence'

import { AccountPanel } from '../chat/sidebar/account-panel'
import { CloudLoginNotice } from '../chat/sidebar/cloud-login-notice'
import { ASSISTANT_ROUTE, DELIVERABLES_ROUTE, HISTORY_ROUTE, PROFILE_STATS_ROUTE, SETTINGS_ROUTE } from '../routes'

import { useSingleThreadNavLabels } from './nav-labels'

type BusinessDestination = 'projects' | 'scheduled-runs'

interface SingleThreadAccountRowProps {
  onNavigateBusiness: (id: BusinessDestination) => void
}

/** The same name AccountPanel shows: an explicit name, else the email's local part, else 「账户」. */
function displayName(account: AuthAccount, fallback: string): string {
  return account.name || (account.email ? account.email.split('@')[0] || account.email : '') || fallback
}

function initialOf(name: string): string {
  return (name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0) || '?').toUpperCase()
}

/** 「快速 · 本月用了 18%」, 「快速」 when the plan is unlimited, null when there is no line to show. */
function usePlanLine(accountId: string): null | string {
  const copy = useSingleThreadSidebarCopy()
  const usage = planUsageFor(useStore($planUsage), accountId)
  const working = useStore($threadPresence).kind === 'working'

  // Read once per account, and again each time a turn ends, which is when the number moves.
  useEffect(() => {
    if (!working || !planUsageReadFor(accountId)) {
      void refreshPlanUsage(accountId)
    }
  }, [accountId, working])

  if (!usage) {
    return null
  }

  return usage.usedRatio === null
    ? usage.planName
    : copy.planUsage({
        percent: formatUsedPercent(usage.usedRatio, copy),
        period: usage.period,
        plan: usage.planName
      })
}

export function SingleThreadAccountRow(props: SingleThreadAccountRowProps) {
  const { status } = useStore($authState)

  if (status !== 'signed-in') {
    return <AccountPanel businessChrome onNavigateBusiness={props.onNavigateBusiness} />
  }

  // hc-1073: the 「登录已失效」 card AccountPanel puts above its row goes above this one too.
  return (
    <>
      <CloudLoginNotice />
      <SignedInAccountRow {...props} />
    </>
  )
}

function SignedInAccountRow({ onNavigateBusiness }: SingleThreadAccountRowProps) {
  const { t } = useI18n()
  const a = t.auth.account
  const { account, accountId } = useStore($authState)
  const owner = accountId || account.email || 'managed'
  const planLine = usePlanLine(owner)
  const [open, setOpen] = useState(false)
  const name = displayName(account, a.fallbackName)
  const email = account.email.trim()
  const subtitle = planLine ?? email

  function onOpenChange(next: boolean) {
    setOpen(next)

    if (next) {
      void loadAccountTeam(accountId)
      void refreshPlanUsage(owner)
    }
  }

  useEffect(() => {
    void loadAccountTeam(accountId)
  }, [accountId])

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`${a.openMenu}: ${name}`}
          className={cn(
            'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors',
            'hover:bg-(--ui-control-hover-background)',
            open && 'bg-(--ui-control-active-background)'
          )}
          data-apex-account-trigger=""
          data-single-thread-account=""
          type="button"
        >
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase leading-none text-white"
            data-apex-account-avatar=""
            style={{ backgroundColor: profileColor(account.email || name) ?? 'var(--theme-primary)' }}
          >
            {initialOf(name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[0.875rem] text-foreground">{name}</span>
            {subtitle ? (
              <span
                className="truncate pt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)"
                data-single-thread-account-line={planLine ? 'plan' : 'email'}
                title={subtitle}
              >
                {subtitle}
              </span>
            ) : null}
          </span>
        </button>
      </DropdownMenuTrigger>
      <SingleThreadAccountMenu onNavigateBusiness={onNavigateBusiness} setOpen={setOpen} />
    </DropdownMenu>
  )
}

function SingleThreadAccountMenu({
  onNavigateBusiness,
  setOpen
}: SingleThreadAccountRowProps & { setOpen: (open: boolean) => void }) {
  const { t } = useI18n()
  const a = t.auth.account
  const nav = useSingleThreadNavLabels(t.sidebar.nav)
  const teamCopy = useAccountTeamCopy()
  const navigate = useNavigate()
  const { accountId } = useStore($authState)
  const team = teamFor(useStore($accountTeam), accountId)
  const [signingOut, setSigningOut] = useState(false)

  // The same sign-out AccountPanel runs: it only reports a failure for the account it started on.
  async function signOut() {
    if (signingOut) {
      return
    }

    const isCurrent = captureManagedAuthRecoveryScope()
    setSigningOut(true)

    try {
      if (!(await signOutAccount()) && isCurrent()) {
        notify({
          kind: 'error',
          message: a.logoutFailed,
          action: {
            label: a.relogin,
            onClick: () => {
              if (isCurrent()) {
                requestManagedReSignIn('')
              }
            }
          }
        })
      }
    } finally {
      setSigningOut(false)

      if (isCurrent()) {
        setOpen(false)
      }
    }
  }

  const item = (icon: string, label: string, onSelect: () => void) => (
    <DropdownMenuItem onSelect={onSelect}>
      <Codicon name={icon} size="0.875rem" />
      <span>{label}</span>
    </DropdownMenuItem>
  )

  return (
    <DropdownMenuContent align="start" className="w-56" side="top" sideOffset={6}>
      {team && (
        <>
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs" data-apex-account-team="">
            <Codicon name="organization" size="0.875rem" />
            <span className="min-w-0 flex-1 truncate text-foreground" title={team.name}>
              {teamCopy.line(team.name)}
            </span>
            {team.isAdmin && <span className="shrink-0 text-(--ui-text-tertiary)">{teamCopy.admin}</span>}
            {team.status === 'pending' && (
              <span className="shrink-0 text-(--ui-text-tertiary)">{teamCopy.pending}</span>
            )}
          </div>
          <DropdownMenuSeparator />
        </>
      )}
      {item('account', a.profile, () => navigate(PROFILE_STATS_ROUTE))}
      {item('settings-gear', a.settings, () => navigate(SETTINGS_ROUTE))}
      {item('folder', nav.projects ?? '', () => onNavigateBusiness('projects'))}
      {item('calendar', nav['scheduled-runs'] ?? '', () => onNavigateBusiness('scheduled-runs'))}
      {item('organization', nav.assistant ?? '', () => navigate(ASSISTANT_ROUTE))}
      {item('history', nav.history ?? '', () => navigate(HISTORY_ROUTE))}
      {item('files', nav.deliverables ?? '', () => navigate(DELIVERABLES_ROUTE))}
      <DropdownMenuSeparator />
      {item('sign-in', a.relogin, () => requestManagedReSignIn(''))}
      <DropdownMenuItem
        disabled={signingOut}
        onSelect={event => {
          event.preventDefault()
          void signOut()
        }}
        variant="destructive"
      >
        <Codicon
          className={signingOut ? 'animate-spin' : undefined}
          name={signingOut ? 'loading' : 'sign-out'}
          size="0.875rem"
        />
        <span>{a.logout}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
