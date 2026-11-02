/**
 * hc-1133: this week's allowance as the account menu's card and Settings › 用量
 * show it. What to say comes from `weeklyQuotaView` (store/plan-usage.ts): while
 * nothing is refused at the allowance it is 「不限量」 with no bar and no reset
 * time, because either would be a number about nothing.
 */

import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { useAccountMenuCopy } from '@/i18n/account-menu'
import { formatUsedPercent, useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { formatBusinessDayTime } from '@/lib/time'
import type { WeeklyQuotaView } from '@/store/plan-usage'

/** 「不限量」, 「还剩 95%」, 「已用完」, 「暂时读不到」. */
export function useWeeklyQuotaValue(view: WeeklyQuotaView): string {
  const copy = useAccountMenuCopy()
  const sidebar = useSingleThreadSidebarCopy()

  if (view.kind === 'unlimited') {
    return copy.unlimited
  }

  if (view.kind === 'unknown') {
    return copy.unavailable
  }

  return view.usedUp ? copy.usedUp : copy.left(formatUsedPercent(view.remainingRatio, sidebar))
}

/** The bar and when the week turns over, only while there is a real limit to measure. */
export function WeeklyQuotaMeter({ view }: { view: WeeklyQuotaView }) {
  const copy = useAccountMenuCopy()
  const { locale } = useI18n()

  if (view.kind !== 'limited') {
    return null
  }

  return (
    <div data-apex-weekly-meter="">
      <Progress aria-label={copy.weeklyUsage} destructive={view.usedUp} size="sm" value={view.remainingRatio} />
      <div className="pt-1.5 text-[0.6875rem] leading-none text-(--ui-text-tertiary)">
        {copy.resets(formatBusinessDayTime(new Date(view.resetsAt), locale))}
      </div>
    </div>
  )
}
