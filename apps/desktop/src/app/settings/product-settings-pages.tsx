/**
 * hc-1109: what product mode's Settings shows that the other modes don't — its
 * rail (product-settings.ts says which tabs, in which order) and the 记忆,
 * 连接微信和飞书 and 用量 pages. hc-1133 adds 账号, 助手与记录 and the plans page
 * (product-account-settings.tsx).
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { planLabel, upgradeLabel, useAccountMenuCopy } from '@/i18n/account-menu'
import { useSettingsProductCopy } from '@/i18n/settings-product'
import { formatUsedPercent, useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { BarChart3, Brain, MessageCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import { isApexAccount } from '@/store/model-tiers'
import { $planUsage, planUsageFor, planUsageOwner, refreshPlanUsage, weeklyQuotaView } from '@/store/plan-usage'

import { ImEntryView } from '../im-entry'
import type { OverlayNavGroup } from '../overlays/overlay-split-layout'
import { PROFILE_STATS_ROUTE } from '../routes'
import { useWeeklyQuotaValue, WeeklyQuotaMeter, weeklyQuotaUsedUp } from '../single-thread/weekly-quota'

import { MemoryLedgerSettings } from './memory-ledger-settings'
import { ListRow, SectionHeading, SettingsContent } from './primitives'
import {
  ACCOUNT_ICON,
  ACTIVITY_ICON,
  ProductAccountSettings,
  ProductActivitySettings,
  ProductPlansSettings
} from './product-account-settings'
import { $productSettingsViews, SETTINGS_PLANS_ROUTE } from './product-settings'
import type { SettingsView } from './types'

/** The rail as given outside product mode; in product mode only the kept tabs, in product order. */
export function useProductSettingsRail(
  groups: OverlayNavGroup[],
  activeView: string,
  select: (view: SettingsView) => void
): OverlayNavGroup[] {
  const views = useStore($productSettingsViews)
  const copy = useSettingsProductCopy()
  const accountCopy = useAccountMenuCopy()

  return useMemo(() => {
    if (!views) {
      return groups
    }

    const byId = new Map(groups.map(group => [group.id, group]))

    const own = (id: SettingsView, icon: OverlayNavGroup['icon'], label: string): OverlayNavGroup => ({
      active: activeView === id,
      icon,
      id,
      label,
      onSelect: () => select(id)
    })

    const memory = byId.get('config:memory')

    // The plans page has no entry: it is opened from 升级 and belongs to 账号, which stays lit.
    const productOnly: Partial<Record<string, OverlayNavGroup>> = {
      account: {
        ...own('account', ACCOUNT_ICON, accountCopy.account),
        active: activeView === 'account' || activeView === 'plans'
      },
      activity: own('activity', ACTIVITY_ICON, accountCopy.activity),
      'config:memory': memory && { ...memory, label: copy.memory },
      im: own('im', MessageCircle, copy.im),
      usage: own('usage', BarChart3, copy.usage)
    }

    // One short list: no gap before 提供方 (developer mode sets one off its sub-nav).
    return views.flatMap(view => {
      const group = productOnly[view] ?? byId.get(view)

      return group ? [{ ...group, gapBefore: false }] : []
    })
  }, [accountCopy, activeView, copy, groups, select, views])
}

/** The page for a product-only tab (and 记忆, the ledger here); null for every other tab. */
export function productSettingsPage(view: string): ReactNode {
  switch (view) {
    case 'account':
      return <ProductAccountSettings />

    case 'activity':
      return <ProductActivitySettings />

    case 'config:memory':
      return <ProductMemorySettings />

    case 'im':
      return <ProductImSettings />

    case 'plans':
      return <ProductPlansSettings />

    case 'usage':
      return <ProductUsageSettings />

    default:
      return null
  }
}

/** 它记得什么: the account's ledger, so without an APEX account it says how to get one. */
function ProductMemorySettings() {
  const copy = useSettingsProductCopy()
  const { accountId, status } = useStore($authState)

  return (
    <SettingsContent>
      {status === 'signed-in' && accountId ? (
        <MemoryLedgerSettings />
      ) : (
        <>
          <SectionHeading icon={Brain} title={copy.memory} />
          <p className="p5-section-intro">{copy.memorySignedOut}</p>
        </>
      )}
    </SettingsContent>
  )
}

/** The 消息渠道 page (scan to bind WeChat or Feishu), the same one the account menu's 助手 page embeds. */
function ProductImSettings() {
  const { t } = useI18n()
  const copy = useSettingsProductCopy()

  return (
    <SettingsContent>
      <SectionHeading icon={MessageCircle} title={copy.im} />
      <p className="p5-section-intro">{t.imEntry.intro}</p>
      <ImEntryView className="-mx-5 w-auto" embedded />
    </SettingsContent>
  )
}

/**
 * The plan and this period's usage, the line the sidebar's account row shows, the
 * way to the history and the plans; hc-1133: and this week's allowance, which the
 * account menu's card opens this page for.
 */
function ProductUsageSettings() {
  const copy = useSettingsProductCopy()
  const accountCopy = useAccountMenuCopy()
  const sidebar = useSingleThreadSidebarCopy()
  const navigate = useNavigate()
  const auth = useStore($authState)
  const owner = planUsageOwner(auth)
  const usage = planUsageFor(useStore($planUsage), owner)
  const signedIn = auth.status === 'signed-in'

  useEffect(() => {
    if (signedIn) {
      void refreshPlanUsage(owner)
    }
  }, [owner, signedIn])

  const weekly = weeklyQuotaView(usage)
  const weeklyValue = useWeeklyQuotaValue(weekly)

  // No line for an unlimited month: the plan alone, and 本周额度 below says 不限量.
  const used =
    usage && usage.usedRatio !== null
      ? copy.usageUsed({ percent: formatUsedPercent(usage.usedRatio, sidebar), period: usage.period })
      : undefined

  return (
    <SettingsContent>
      <SectionHeading icon={BarChart3} title={copy.usage} />
      <p className="p5-section-intro">{copy.usageIntro}</p>
      <div className="p5-card p5-rows mt-3.5">
        <ListRow
          action={
            <span className="flex items-center gap-2">
              {isApexAccount(auth) && (
                <Button onClick={() => navigate(SETTINGS_PLANS_ROUTE)} size="sm" type="button" variant="outline">
                  {upgradeLabel(usage, auth.account.plan, accountCopy)}
                </Button>
              )}
              <Button onClick={() => navigate(PROFILE_STATS_ROUTE)} size="sm" type="button" variant="outline">
                {copy.usageHistory}
              </Button>
            </span>
          }
          description={used}
          title={usage ? planLabel(usage, auth.account.plan, accountCopy) : copy.usageNone}
        />
        {usage && (
          <ListRow
            action={
              <span
                className={cn('text-xs text-(--ui-text-secondary)', weeklyQuotaUsedUp(weekly) && 'text-destructive')}
              >
                {weeklyValue}
              </span>
            }
            below={
              weekly.kind === 'limited' ? (
                <div className="pt-2">
                  <WeeklyQuotaMeter view={weekly} />
                </div>
              ) : undefined
            }
            title={accountCopy.weeklyUsage}
          />
        )}
      </div>
    </SettingsContent>
  )
}
