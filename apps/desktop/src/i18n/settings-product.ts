/**
 * Copy for hc-1109: Settings in single-thread product mode — the line under
 * its title, the rail's three product names and the 记忆 / 连接微信和飞书 / 用量
 * pages.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface SettingsProductCopy {
  /** Under 「设置」: names only what product mode shows. */
  description: string
  /** The rail: 「记忆与上下文」 shows only the memory ledger here, so it is just 「记忆」. */
  memory: string
  im: string
  usage: string
  /** 记忆 without an APEX account: the ledger belongs to the account. */
  memorySignedOut: string
  usageIntro: string
  /** 「本月用了 18%」: `percent` is already formatted (「18%」, 「不到 1%」). */
  usageUsed: (parts: { percent: string; period: 'month' | 'week' }) => string
  usageUnlimited: string
  /** No plan line: signed out, an older cloud, or the read failed. */
  usageNone: string
  /** Opens the per-day usage history (the account menu's 个人资料 page). */
  usageHistory: string
}

const en: SettingsProductCopy = {
  description: 'Manage APEX’s personalization, memory, notifications, appearance and usage.',
  memory: 'Memory',
  im: 'WeChat & Feishu',
  usage: 'Usage',
  memorySignedOut: 'Sign in to your APEX account to see what it remembers here, and to edit, delete or add to it.',
  usageIntro: 'Your plan, and how much of it you have used this period.',
  usageUsed: ({ percent, period }) => `${percent} used this ${period}`,
  usageUnlimited: 'Unlimited',
  usageNone: 'No usage to show yet. Sign in to your APEX account to see your plan and how much you have used.',
  usageHistory: 'See usage history'
}

const zh: SettingsProductCopy = {
  description: '管理 APEX 的个性化、记忆、通知、外观和用量。',
  memory: '记忆',
  im: '连接微信和飞书',
  usage: '用量',
  memorySignedOut: '登录 APEX 账号后，这里会列出它记得的事，每条都能改、删、加。',
  usageIntro: '你的套餐，和这个周期用了多少。',
  usageUsed: ({ percent, period }) => `${period === 'week' ? '本周' : '本月'}用了 ${percent}`,
  usageUnlimited: '不限量',
  usageNone: '还没读到用量。登录 APEX 账号后，这里会显示套餐和用了多少。',
  usageHistory: '查看使用记录'
}

const zhHant: SettingsProductCopy = {
  description: '管理 APEX 的個人化、記憶、通知、外觀和用量。',
  memory: '記憶',
  im: '連接微信和飛書',
  usage: '用量',
  memorySignedOut: '登入 APEX 帳號後，這裡會列出它記得的事，每條都能改、刪、加。',
  usageIntro: '你的方案，和這個週期用了多少。',
  usageUsed: ({ percent, period }) => `${period === 'week' ? '本週' : '本月'}用了 ${percent}`,
  usageUnlimited: '不限量',
  usageNone: '還沒讀到用量。登入 APEX 帳號後，這裡會顯示方案和用了多少。',
  usageHistory: '查看使用紀錄'
}

export const SETTINGS_PRODUCT_COPY: Readonly<Record<Locale, SettingsProductCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSettingsProductCopy(): SettingsProductCopy {
  return SETTINGS_PRODUCT_COPY[useI18n().locale]
}
