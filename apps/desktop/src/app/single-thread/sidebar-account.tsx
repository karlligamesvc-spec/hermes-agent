/**
 * hc-1061 G3: the single-thread sidebar's account row, as prototype v2 draws it:
 * the name over the plan's name, falling back to the email when the cloud gives
 * no usage line. hc-1133: the row carries no number. Beside 「不限量」 on the menu's
 * card, a month's percent read as a contradiction; a limit that is real shows
 * there too.
 *
 * hc-1133: its menu is the account and nothing else: who is signed in, the plan
 * with 升级 and this week's allowance, 设置, 联系我们, 退出登录. What it used to
 * list moved into Settings (个人资料 and 重新登录 to 账号; 定时运行, 连接助手 and
 * 更早的对话 to 助手与记录). AccountPanel stays as it is for every other mode: its
 * account-menu goldens are pinned. A session that is not signed in, or has
 * expired, gets AccountPanel itself: its sign-in recovery card is the one to show.
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
import { planLabel, upgradeLabel, useAccountMenuCopy } from '@/i18n/account-menu'
import { useAccountTeamCopy } from '@/i18n/account-team'
import { openExternalLink } from '@/lib/external-link'
import { cn } from '@/lib/utils'
import { $accountTeam, loadAccountTeam, teamFor } from '@/store/account-team'
import { $authState, $signingOut, prepareSignOut } from '@/store/auth'
import { notify } from '@/store/notifications'
import {
  $planUsage,
  planUsageFor,
  planUsageOwner,
  planUsageReadFor,
  refreshPlanUsage,
  weeklyQuotaView
} from '@/store/plan-usage'
import { $threadPresence } from '@/store/single-thread-presence'

import { AccountPanel } from '../chat/sidebar/account-panel'
import { CloudLoginNotice } from '../chat/sidebar/cloud-login-notice'
import { SETTINGS_ROUTE } from '../routes'
import { SETTINGS_PLANS_ROUTE, SETTINGS_USAGE_ROUTE } from '../settings/product-settings'

import { AccountAvatar, accountDisplayName } from './account-identity'
import { signOutFromAccountMenu } from './sign-out'
import { useWeeklyQuotaValue, WeeklyQuotaMeter, weeklyQuotaUsedUp } from './weekly-quota'

/** The address the website's footer and terms give (apex-nodes web/lib/support.ts). */
const SUPPORT_EMAIL = 'support@apex-nodes.com'

/** The plan's name and no number, the same name as the menu's card; null when there is no line to show. */
function usePlanLine(accountId: string, accountPlan: string): null | string {
  const copy = useAccountMenuCopy()
  const usage = planUsageFor(useStore($planUsage), accountId)
  const working = useStore($threadPresence).kind === 'working'

  // Read once per account, and again each time a turn ends, so a change of plan shows without opening the menu.
  useEffect(() => {
    if (!working || !planUsageReadFor(accountId)) {
      void refreshPlanUsage(accountId)
    }
  }, [accountId, working])

  return usage ? planLabel(usage, accountPlan, copy) : null
}

export function SingleThreadAccountRow() {
  const { status } = useStore($authState)

  if (status !== 'signed-in') {
    return <AccountPanel businessChrome />
  }

  // hc-1073: the 「登录已失效」 card AccountPanel puts above its row goes above this one too.
  return (
    <>
      <CloudLoginNotice />
      <SignedInAccountRow />
    </>
  )
}

function SignedInAccountRow() {
  const { t } = useI18n()
  const a = t.auth.account
  const { account, accountId } = useStore($authState)
  const owner = planUsageOwner({ account, accountId })
  const planLine = usePlanLine(owner, account.plan)
  const [open, setOpen] = useState(false)
  const name = accountDisplayName(account, a.fallbackName)
  const email = account.email.trim()
  const subtitle = planLine ?? email

  function onOpenChange(next: boolean) {
    setOpen(next)

    if (next) {
      void loadAccountTeam(accountId)
      void refreshPlanUsage(owner)
      prepareSignOut()
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
          <AccountAvatar account={account} name={name} />
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
      <SingleThreadAccountMenu name={name} setOpen={setOpen} />
    </DropdownMenu>
  )
}

const MENU_ROW = 'gap-2.5 px-2 py-1.5 text-[0.8125rem]'

/** The plan with 升级, and this week's allowance: the account's, whichever assistant is on screen. */
function PlanCard() {
  const copy = useAccountMenuCopy()
  const navigate = useNavigate()
  const auth = useStore($authState)
  const usage = planUsageFor(useStore($planUsage), planUsageOwner(auth))
  const view = weeklyQuotaView(usage)
  const value = useWeeklyQuotaValue(view)

  return (
    <div
      className="mt-1 mb-1.5 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/50"
      data-apex-account-plan-card=""
    >
      <div className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-3">
        <span className="min-w-0 truncate text-[0.8125rem] font-semibold text-foreground" data-apex-account-plan="">
          {planLabel(usage, auth.account.plan, copy)}
        </span>
        <DropdownMenuItem
          className="shrink-0 rounded-full border border-(--ui-stroke-secondary) px-2.5 py-1 font-medium text-foreground"
          onSelect={() => navigate(SETTINGS_PLANS_ROUTE)}
        >
          {upgradeLabel(usage, auth.account.plan, copy)}
        </DropdownMenuItem>
      </div>
      <div className="border-t border-dashed border-(--ui-stroke-tertiary) p-1">
        <DropdownMenuItem
          className={MENU_ROW}
          data-apex-weekly-quota={view.kind}
          onSelect={() => navigate(SETTINGS_USAGE_ROUTE)}
        >
          <Codicon name="dashboard" size="0.875rem" />
          <span className="min-w-0 flex-1 truncate">{copy.weeklyUsage}</span>
          <span className={cn('shrink-0 text-(--ui-text-tertiary)', weeklyQuotaUsedUp(view) && 'text-destructive')}>
            {value}
          </span>
          <Codicon name="chevron-right" size="0.75rem" />
        </DropdownMenuItem>
        {view.kind === 'limited' && (
          <div className="px-2 pt-0.5 pb-1.5">
            <WeeklyQuotaMeter view={view} />
          </div>
        )}
      </div>
    </div>
  )
}

function SingleThreadAccountMenu({ name, setOpen }: { name: string; setOpen: (open: boolean) => void }) {
  const { t } = useI18n()
  const a = t.auth.account
  const copy = useAccountMenuCopy()
  const teamCopy = useAccountTeamCopy()
  const navigate = useNavigate()
  const { account, accountId } = useStore($authState)
  const team = teamFor(useStore($accountTeam), accountId)
  const email = account.email.trim()
  const signingOut = useStore($signingOut)

  // hc-1142: the menu closes on the click and the window says 「正在退出登录…」 (DesktopAuthGate) until the server answers.
  function signOut() {
    if (signingOut) {
      return
    }

    setOpen(false)
    void signOutFromAccountMenu()
  }

  // The mail app is the OS's to open; a computer without one set up shows nothing, so the address stays on screen.
  function contactUs() {
    openExternalLink(`mailto:${SUPPORT_EMAIL}`)
    notify({
      kind: 'info',
      message: copy.contactNotice(SUPPORT_EMAIL),
      action: { label: copy.copyAddress, onClick: () => void navigator.clipboard.writeText(SUPPORT_EMAIL) }
    })
  }

  return (
    <DropdownMenuContent align="start" className="w-72 p-1.5" side="top" sideOffset={6}>
      <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-2" data-apex-account-menu-identity="">
        <AccountAvatar account={account} name={name} size="size-9" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[0.875rem] font-medium text-foreground">{name}</div>
          {email ? (
            <div className="truncate pt-0.5 text-xs text-(--ui-text-tertiary)" title={email}>
              {email}
            </div>
          ) : null}
        </div>
      </div>
      {team && (
        <div className="flex items-center gap-2 px-2 pb-2 text-xs" data-apex-account-team="">
          <Codicon name="organization" size="0.875rem" />
          <span className="min-w-0 flex-1 truncate text-foreground" title={team.name}>
            {teamCopy.line(team.name)}
          </span>
          {team.isAdmin && <span className="shrink-0 text-(--ui-text-tertiary)">{teamCopy.admin}</span>}
          {team.status === 'pending' && <span className="shrink-0 text-(--ui-text-tertiary)">{teamCopy.pending}</span>}
        </div>
      )}
      <PlanCard />
      <DropdownMenuItem className={MENU_ROW} onSelect={() => navigate(SETTINGS_ROUTE)}>
        <Codicon name="settings-gear" size="0.875rem" />
        <span>{a.settings}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={MENU_ROW} onSelect={contactUs}>
        <Codicon name="mail" size="0.875rem" />
        <span className="flex-1">{copy.contact}</span>
        <Codicon name="link-external" size="0.75rem" />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className={MENU_ROW}
        disabled={signingOut}
        onSelect={event => {
          event.preventDefault()
          signOut()
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
