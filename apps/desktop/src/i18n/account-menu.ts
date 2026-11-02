/**
 * Copy for hc-1133: the account menu in single-thread product mode, the Settings
 * pages that took over its other entries (账号, 助手与记录) and the plans page.
 *
 * No price and no amount of money appears here: prices are not set. The plans
 * differ by how many times the free allowance they get, nothing else is claimed
 * for them.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import type { DesktopPlanUsage } from '@/global'
import { accountPlanTier, type PlanTier } from '@/store/plan-usage'

import { useI18n } from './context'
import type { Locale } from './types'

export interface AccountMenuCopy {
  /** The plan's line when neither the cloud nor the sign-in names one. */
  planFallback: string
  planNames: Record<PlanTier, string>
  upgrade: string
  /** The same button for someone already on the top plan. */
  viewPlans: string
  weeklyUsage: string
  unlimited: string
  /** `percent` is already formatted (「95%」, 「不到 1%」). */
  left: (percent: string) => string
  usedUp: string
  /** The cloud gave no weekly line, or one that cannot be read. */
  unavailable: string
  /** `when` is already formatted for the locale and the local time zone. */
  resets: (when: string) => string
  contact: string
  /** The toast beside the mail window, for a computer with no mail app set up. */
  contactNotice: (address: string) => string
  copyAddress: string

  /** Settings › 账号: the rail's name and the page. */
  account: string
  accountIntro: string
  plan: string
  /** The row that opens 个人资料. */
  profileDescription: string
  reSignInDescription: string
  open: string
  /** Settings › 助手与记录: the rail's name and the page. */
  activity: string
  activityIntro: string
  scheduledRunsDescription: string
  assistantDescription: string
  historyDescription: string

  /** The plans page. */
  plansTitle: string
  plansIntro: string
  /** Over the plans while nothing is limited yet. */
  plansUnlimitedNote: string
  planAllowances: Record<PlanTier, string>
  /** Paid plans, instead of a price. */
  priceSoon: string
  currentPlan: string
  upgradeTo: (plan: string) => string
  testingNotice: string
}

const en: AccountMenuCopy = {
  planFallback: 'Your plan',
  planNames: { free: 'Free', max: 'Max', pro: 'Pro' },
  upgrade: 'Upgrade',
  viewPlans: 'View plans',
  weeklyUsage: 'Weekly usage',
  unlimited: 'Unlimited',
  left: percent => `${percent} left`,
  usedUp: 'Used up',
  unavailable: 'Unavailable right now',
  resets: when => `Resets ${when}`,
  contact: 'Contact us',
  contactNotice: address => `No mail window? Write to us at ${address}.`,
  copyAddress: 'Copy address',

  account: 'Account',
  accountIntro: 'Your APEX account. The plan and its usage belong to the account, not to one assistant.',
  plan: 'Plan',
  profileDescription: 'Your account details and how much you have used.',
  reSignInDescription: 'For when your login has expired, or to switch to another account.',
  open: 'Open',
  activity: 'Assistants & history',
  activityIntro: 'Scheduled runs, your connected assistant and earlier conversations.',
  scheduledRunsDescription: 'Have an assistant do something on a schedule.',
  assistantDescription: 'See your messaging channels and what is running.',
  historyDescription: 'Find what you talked about before.',

  plansTitle: 'Plans',
  plansIntro: 'Pick the plan that fits how much you use APEX.',
  plansUnlimitedNote: 'Usage is unlimited right now. Once paid plans launch, each plan gets the allowance below.',
  planAllowances: {
    free: 'The base weekly allowance',
    max: '15× the Free weekly allowance',
    pro: '5× the Free weekly allowance'
  },
  priceSoon: 'Price coming soon',
  currentPlan: 'Current plan',
  upgradeTo: plan => `Upgrade to ${plan}`,
  testingNotice: 'Paid plans are still being tested and will launch later. You have not been charged.'
}

const zh: AccountMenuCopy = {
  planFallback: '当前套餐',
  planNames: { free: '免费', max: 'Max', pro: 'Pro' },
  upgrade: '升级',
  viewPlans: '查看套餐',
  weeklyUsage: '本周额度',
  unlimited: '不限量',
  left: percent => `还剩 ${percent}`,
  usedUp: '已用完',
  unavailable: '暂时读不到',
  resets: when => `${when} 重置`,
  contact: '联系我们',
  contactNotice: address => `没有弹出邮件窗口？可以直接发邮件到 ${address}。`,
  copyAddress: '复制地址',

  account: '账号',
  accountIntro: '你的 APEX 账号。套餐和额度按账号算，不分助手。',
  plan: '套餐',
  profileDescription: '账号信息和使用情况。',
  reSignInDescription: '登录过期，或者想换一个账号时用。',
  open: '打开',
  activity: '助手与记录',
  activityIntro: '定时运行、连接助手，和更早的对话。',
  scheduledRunsDescription: '让助手按时自动做事。',
  assistantDescription: '查看消息渠道和正在运行的事。',
  historyDescription: '找回以前聊过的内容。',

  plansTitle: '套餐',
  plansIntro: '选一个适合你用量的套餐。',
  plansUnlimitedNote: '现在额度不限量。付费功能推出后，各套餐的额度如下。',
  planAllowances: {
    free: '基础的每周额度',
    max: '每周额度是免费的 15 倍',
    pro: '每周额度是免费的 5 倍'
  },
  priceSoon: '价格待公布',
  currentPlan: '当前套餐',
  upgradeTo: plan => `升级到 ${plan}`,
  testingNotice: '付费功能正在测试中，后续推出，现在不会扣费。'
}

const zhHant: AccountMenuCopy = {
  planFallback: '目前方案',
  planNames: { free: '免費', max: 'Max', pro: 'Pro' },
  upgrade: '升級',
  viewPlans: '查看方案',
  weeklyUsage: '本週額度',
  unlimited: '不限量',
  left: percent => `還剩 ${percent}`,
  usedUp: '已用完',
  unavailable: '暫時讀不到',
  resets: when => `${when} 重置`,
  contact: '聯絡我們',
  contactNotice: address => `沒有跳出郵件視窗？可以直接寄信到 ${address}。`,
  copyAddress: '複製地址',

  account: '帳號',
  accountIntro: '你的 APEX 帳號。方案和額度按帳號算，不分助手。',
  plan: '方案',
  profileDescription: '帳號資訊和使用情況。',
  reSignInDescription: '登入過期，或者想換一個帳號時用。',
  open: '開啟',
  activity: '助手與紀錄',
  activityIntro: '定時執行、連接助手，和更早的對話。',
  scheduledRunsDescription: '讓助手按時自動做事。',
  assistantDescription: '查看訊息渠道和正在執行的事。',
  historyDescription: '找回以前聊過的內容。',

  plansTitle: '方案',
  plansIntro: '選一個適合你用量的方案。',
  plansUnlimitedNote: '現在額度不限量。付費功能推出後，各方案的額度如下。',
  planAllowances: {
    free: '基礎的每週額度',
    max: '每週額度是免費的 15 倍',
    pro: '每週額度是免費的 5 倍'
  },
  priceSoon: '價格待公布',
  currentPlan: '目前方案',
  upgradeTo: plan => `升級到 ${plan}`,
  testingNotice: '付費功能正在測試中，後續推出，現在不會扣費。'
}

export const ACCOUNT_MENU_COPY: Readonly<Record<Locale, AccountMenuCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useAccountMenuCopy(): AccountMenuCopy {
  return ACCOUNT_MENU_COPY[useI18n().locale]
}

/**
 * The plan's name, the same everywhere the account shows it: what the plans page
 * lists it as, else what the cloud calls it. `accountPlan` is the code the sign-in
 * gave, for when usage has not been read. Empty when nothing names it: a code is
 * not a name, so a code this build does not know is never shown.
 */
export function knownPlanName(usage: DesktopPlanUsage | null, accountPlan: string, copy: AccountMenuCopy): string {
  const tier = accountPlanTier(usage, accountPlan)

  if (tier) {
    return copy.planNames[tier]
  }

  const name = usage?.planName ?? ''

  return name === usage?.planCode || name === accountPlan.trim() ? '' : name
}

/** The plan's name where a line always has to say something. */
export function planLabel(usage: DesktopPlanUsage | null, accountPlan: string, copy: AccountMenuCopy): string {
  return knownPlanName(usage, accountPlan, copy) || copy.planFallback
}

/** 升级, or 查看套餐 for someone already on the top plan. */
export function upgradeLabel(usage: DesktopPlanUsage | null, accountPlan: string, copy: AccountMenuCopy): string {
  return accountPlanTier(usage, accountPlan) === 'max' ? copy.viewPlans : copy.upgrade
}
