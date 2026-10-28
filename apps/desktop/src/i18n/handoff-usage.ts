/**
 * hc-1090 多助手二期 R5: the usage line on the relay confirmation card (R2 draws
 * the card): 「要多跑 2 个回合，按你的套餐额度算 · 本月已用 18%」, a reminder past
 * 80%, and no relay once the allowance is used up (L6). Never an amount of money.
 *
 * The percent is the sidebar account row's (hc-1062, `formatUsedPercent`), so
 * the card and the row never disagree. Kept beside the main catalogs, which are
 * past the code-health size cap; zh, zh-hant and en are written out, ja and ar
 * read en.
 */

import type { DesktopPlanUsage } from '@/global'

import { formatUsedPercent, SINGLE_THREAD_SIDEBAR_COPY } from './single-thread-sidebar'
import type { Locale } from './types'

/** Past this share of the allowance (strictly more), the card adds a reminder. */
export const HANDOFF_USAGE_NEAR_RATIO = 0.8

/**
 * - ok: under the reminder;
 * - near: more than {@link HANDOFF_USAGE_NEAR_RATIO} used;
 * - used_up: the allowance is used up (the relay's turns could not run);
 * - unlimited: the plan has no allowance to count against;
 * - unknown: no usage line (not read yet, an older cloud, an installer-only account).
 */
export type HandoffUsageLevel = 'near' | 'ok' | 'unknown' | 'unlimited' | 'used_up'

export interface HandoffUsageHint {
  /** False only when the allowance is used up: the card does not start the relay. */
  start: boolean
  level: HandoffUsageLevel
  /** The card's line; without a number to show (unknown, unlimited) it stops after 「按你的套餐额度算」. */
  line: string
  /** More than 80% used: one sentence under the line. */
  warning: null | string
  /** Used up: why the relay is not started, shown in place of the start button. */
  reason: null | string
}

type Period = DesktopPlanUsage['period']

interface HandoffUsageCopy {
  line: (turns: number, used: null | { percent: string; period: Period }) => string
  near: (period: Period) => string
  usedUp: (period: Period) => string
}

const en: HandoffUsageCopy = {
  line: (turns, used) =>
    `Takes ${turns} more ${turns === 1 ? 'turn' : 'turns'}, counted against your plan` +
    (used ? ` · ${used.percent} used this ${used.period}` : ''),
  near: period => `Over 80% of this ${period}’s allowance is used. These turns may use up the rest.`,
  usedUp: period =>
    `This ${period}’s allowance is used up, so this won’t be handed over: the other assistant can’t run a turn now. ` +
    `Try again once it resets next ${period}.`
}

const zh: HandoffUsageCopy = {
  line: (turns, used) =>
    `要多跑 ${turns} 个回合，按你的套餐额度算` +
    (used ? ` · ${used.period === 'week' ? '本周' : '本月'}已用 ${used.percent}` : ''),
  near: period => `${period === 'week' ? '本周' : '本月'}额度已用过 80%，多跑几个回合可能就用完了。`,
  usedUp: period =>
    period === 'week'
      ? '本周额度已经用完，这次先不交出去：接手的助手跑不了新回合。下周额度恢复后再试。'
      : '本月额度已经用完，这次先不交出去：接手的助手跑不了新回合。下个月额度恢复后再试。'
}

const zhHant: HandoffUsageCopy = {
  line: (turns, used) =>
    `要多跑 ${turns} 個回合，按你的方案額度算` +
    (used ? ` · ${used.period === 'week' ? '本週' : '本月'}已用 ${used.percent}` : ''),
  near: period => `${period === 'week' ? '本週' : '本月'}額度已用過 80%，多跑幾個回合可能就用完了。`,
  usedUp: period =>
    period === 'week'
      ? '本週額度已經用完，這次先不交出去：接手的助手跑不了新回合。下週額度恢復後再試。'
      : '本月額度已經用完，這次先不交出去：接手的助手跑不了新回合。下個月額度恢復後再試。'
}

const COPY: Readonly<Record<Locale, HandoffUsageCopy>> = { ar: en, en, ja: en, zh, 'zh-hant': zhHant }

function levelOf(usage: DesktopPlanUsage | null): HandoffUsageLevel {
  if (!usage) {
    return 'unknown'
  }

  if (usage.usedRatio === null) {
    return 'unlimited'
  }

  if (usage.usedRatio >= 1) {
    return 'used_up'
  }

  return usage.usedRatio > HANDOFF_USAGE_NEAR_RATIO ? 'near' : 'ok'
}

/**
 * The confirmation card's usage hint for a relay that runs `turns` more turns
 * (at least 1), from the account's usage line (store/plan-usage.ts).
 */
export function handoffUsageHint(turns: number, usage: DesktopPlanUsage | null, locale: Locale): HandoffUsageHint {
  const copy = COPY[locale] ?? en
  const count = Number.isFinite(turns) ? Math.max(1, Math.floor(turns)) : 1
  const level = levelOf(usage)

  const used =
    usage && usage.usedRatio !== null
      ? { percent: formatUsedPercent(usage.usedRatio, SINGLE_THREAD_SIDEBAR_COPY[locale]), period: usage.period }
      : null

  return {
    level,
    line: copy.line(count, used),
    reason: level === 'used_up' && usage ? copy.usedUp(usage.period) : null,
    start: level !== 'used_up',
    warning: level === 'near' && usage ? copy.near(usage.period) : null
  }
}
