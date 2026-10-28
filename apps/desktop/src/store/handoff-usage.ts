/**
 * hc-1090 多助手二期 R5: the usage hint for the relay confirmation card (R2) —
 * 「要多跑 N 个回合，按你的套餐额度算 · 本月已用 x%」, a reminder past 80%, and
 * `start: false` with the reason once the allowance is used up (L6; the wording
 * is i18n/handoff-usage.ts). The number is the account's usage line, read
 * through main with the login JWT (store/plan-usage.ts, hc-1062), the same one
 * the sidebar account row shows.
 *
 * Off (relay off), both return null and read nothing.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { useI18n } from '@/i18n'
import { type HandoffUsageHint, handoffUsageHint } from '@/i18n/handoff-usage'
import { getRuntimeI18nLocale } from '@/i18n/runtime'

import { $authState } from './auth'
import { $planUsage, planUsageFor, planUsageOwner, refreshPlanUsage } from './plan-usage'
import { isHandoffMode, useHandoffMode } from './single-thread-handoff'

export type { HandoffUsageHint, HandoffUsageLevel } from '@/i18n/handoff-usage'

/**
 * The confirmation card's hint for a relay that runs `turns` more turns. The
 * usage line is read again when the card mounts, so the percent is current;
 * until it lands the last one read is shown (or none: `level: 'unknown'`).
 */
export function useHandoffUsageHint(turns: number): HandoffUsageHint | null {
  const on = useHandoffMode()
  const owner = planUsageOwner(useStore($authState))
  const usage = planUsageFor(useStore($planUsage), owner)
  const { locale } = useI18n()

  useEffect(() => {
    if (on) {
      void refreshPlanUsage(owner)
    }
  }, [on, owner])

  return on ? handoffUsageHint(turns, usage, locale) : null
}

/**
 * The same hint outside React (a click that starts a relay without the card, a
 * chain's plan): reads the usage line first, so a used-up allowance is seen.
 */
export async function checkHandoffUsage(turns: number): Promise<HandoffUsageHint | null> {
  if (!isHandoffMode()) {
    return null
  }

  const owner = planUsageOwner($authState.get())

  await refreshPlanUsage(owner)

  return handoffUsageHint(turns, planUsageFor($planUsage.get(), owner), getRuntimeI18nLocale())
}
