/**
 * hc-1133: what the account menu handed to Settings in product mode.
 *
 * 账号 is who is signed in, the plan, 个人资料 and 重新登录: things that belong to
 * the account, whichever assistant is on screen. 助手与记录 is 定时运行, 连接助手 and
 * 更早的对话: what the assistants do and said. Each row opens the same page or the
 * same sign-in the menu item did. The plans page is reached from 升级 and has no
 * rail entry of its own; 账号 stays lit while it is open.
 *
 * Nothing on the plans page buys anything: no price is set and no payment is wired
 * to it, so a paid plan's button only says so.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { codiconIcon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { type AccountMenuCopy, planLabel, useAccountMenuCopy } from '@/i18n/account-menu'
import { Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import { requestManagedReSignIn } from '@/store/onboarding'
import {
  $planUsage,
  type PlanTier,
  planTierOf,
  planUsageFor,
  planUsageOwner,
  refreshPlanUsage,
  weeklyQuotaView
} from '@/store/plan-usage'

import { ASSISTANT_ROUTE, CRON_ROUTE, HISTORY_ROUTE, navigateToWorkspacePage, PROFILE_STATS_ROUTE } from '../routes'
import { AccountAvatar, accountDisplayName } from '../single-thread/account-identity'
import { useSingleThreadNavLabels } from '../single-thread/nav-labels'

import { ListRow, Pill, SectionHeading, SettingsContent } from './primitives'
import { SETTINGS_PLANS_ROUTE } from './product-settings'

export const ACCOUNT_ICON = codiconIcon('account')
export const ACTIVITY_ICON = codiconIcon('history')

/** The account's plan usage, read when the page opens; null until there is a line to show. */
function useAccountPlanUsage() {
  const auth = useStore($authState)
  const owner = planUsageOwner(auth)
  const signedIn = auth.status === 'signed-in'

  useEffect(() => {
    if (signedIn) {
      void refreshPlanUsage(owner)
    }
  }, [owner, signedIn])

  return { auth, usage: planUsageFor(useStore($planUsage), owner) }
}

export function ProductAccountSettings() {
  const { t } = useI18n()
  const a = t.auth.account
  const copy = useAccountMenuCopy()
  const navigate = useNavigate()
  const { auth, usage } = useAccountPlanUsage()
  const name = accountDisplayName(auth.account, a.fallbackName)
  const email = auth.account.email.trim()
  const expired = auth.status === 'expired'
  const onTopPlan = planTierOf(usage?.planCode ?? auth.account.plan) === 'max'

  return (
    <SettingsContent>
      <SectionHeading icon={ACCOUNT_ICON} title={copy.account} />
      <p className="p5-section-intro">{copy.accountIntro}</p>
      <div className="p5-card p5-rows mt-3.5">
        <ListRow
          description={email || undefined}
          title={
            <span className="flex items-center gap-2.5" data-apex-account-settings-name="">
              <AccountAvatar account={auth.account} name={name} />
              <span className="min-w-0 truncate">{name}</span>
            </span>
          }
        />
        <ListRow
          action={
            <Button onClick={() => navigate(SETTINGS_PLANS_ROUTE)} size="sm" type="button" variant="outline">
              {onTopPlan ? copy.viewPlans : copy.upgrade}
            </Button>
          }
          description={planLabel(usage, auth.account.plan, copy)}
          title={copy.plan}
        />
        <ListRow
          action={
            <Button onClick={() => navigate(PROFILE_STATS_ROUTE)} size="sm" type="button" variant="outline">
              {copy.open}
            </Button>
          }
          description={copy.profileDescription}
          title={a.profile}
        />
        <ListRow
          action={
            <Button
              onClick={() => requestManagedReSignIn(expired ? t.auth.login.sessionExpired : '')}
              size="sm"
              type="button"
              variant="outline"
            >
              {a.relogin}
            </Button>
          }
          description={expired ? a.sessionExpiredTitle : copy.reSignInDescription}
          title={a.relogin}
        />
      </div>
    </SettingsContent>
  )
}

export function ProductActivitySettings() {
  const { t } = useI18n()
  const nav = useSingleThreadNavLabels(t.sidebar.nav)
  const copy = useAccountMenuCopy()
  const navigate = useNavigate()

  const row = (title: string, description: string, open: () => void) => (
    <ListRow
      action={
        <Button onClick={open} size="sm" type="button" variant="outline">
          {copy.open}
        </Button>
      }
      description={description}
      title={title}
    />
  )

  return (
    <SettingsContent>
      <SectionHeading icon={ACTIVITY_ICON} title={copy.activity} />
      <p className="p5-section-intro">{copy.activityIntro}</p>
      <div className="p5-card p5-rows mt-3.5">
        {row(nav['scheduled-runs'] ?? '', copy.scheduledRunsDescription, () =>
          navigateToWorkspacePage(navigate, CRON_ROUTE)
        )}
        {row(nav.assistant ?? '', copy.assistantDescription, () => navigate(ASSISTANT_ROUTE))}
        {row(nav.history ?? '', copy.historyDescription, () => navigate(HISTORY_ROUTE))}
      </div>
    </SettingsContent>
  )
}

const PLAN_ORDER: readonly PlanTier[] = ['free', 'pro', 'max']

function PlanColumn({
  copy,
  current,
  onChoosePaid,
  tier
}: {
  copy: AccountMenuCopy
  current: null | PlanTier
  onChoosePaid: () => void
  tier: PlanTier
}) {
  const isCurrent = tier === current
  const name = copy.planNames[tier]
  // A plan below the current one has nothing to offer here: there is no downgrade to start.
  const canUpgrade = tier !== 'free' && (current === null || PLAN_ORDER.indexOf(tier) > PLAN_ORDER.indexOf(current))

  return (
    <div
      className={cn('p5-card flex min-w-0 flex-col gap-1.5 p-4', isCurrent && 'border-primary!')}
      data-apex-plan={tier}
      data-current={isCurrent ? 'true' : undefined}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-foreground">{name}</span>
        {isCurrent && <Pill tone="primary">{copy.currentPlan}</Pill>}
      </div>
      <p className="text-xs leading-5 text-(--ui-text-secondary)">{copy.planAllowances[tier]}</p>
      <p className="min-h-5 text-xs leading-5 text-(--ui-text-tertiary)">{tier === 'free' ? '' : copy.priceSoon}</p>
      {canUpgrade && (
        <Button className="mt-1.5 w-full" onClick={onChoosePaid} size="sm" type="button">
          {copy.upgradeTo(name)}
        </Button>
      )}
    </div>
  )
}

export function ProductPlansSettings() {
  const copy = useAccountMenuCopy()
  const { auth, usage } = useAccountPlanUsage()
  const [testingNotice, setTestingNotice] = useState(false)
  const current = planTierOf(usage?.planCode ?? auth.account.plan)

  return (
    <SettingsContent>
      <SectionHeading icon={Sparkles} title={copy.plansTitle} />
      <p className="p5-section-intro">{copy.plansIntro}</p>
      {weeklyQuotaView(usage).kind === 'unlimited' && (
        <p className="mt-2 text-xs leading-5 text-(--ui-text-tertiary)" data-apex-plans-unlimited-note="">
          {copy.plansUnlimitedNote}
        </p>
      )}
      <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3" data-apex-plans="">
        {PLAN_ORDER.map(tier => (
          <PlanColumn
            copy={copy}
            current={current}
            key={tier}
            onChoosePaid={() => setTestingNotice(true)}
            tier={tier}
          />
        ))}
      </div>
      {/* Mounted empty, so a screen reader announces what appears in it. */}
      <div className="mt-3.5" role="status">
        {testingNotice && (
          <div
            className="rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-3 py-2 text-xs leading-5 text-foreground"
            data-apex-plans-testing-notice=""
          >
            {copy.testingTitle}
            {copy.testingBody}
          </div>
        )}
      </div>
    </SettingsContent>
  )
}
