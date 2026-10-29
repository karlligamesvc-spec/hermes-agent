/**
 * Copy for hc-1061 G3: the single-thread sidebar as prototype v2 draws it — the
 * search button, the assistant row's status line, 「在微信里找 APEX」 and the
 * account row's plan line.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface SingleThreadSidebarCopy {
  /** The round button atop the sidebar (opens the command palette). */
  search: string
  /** The assistant row's status line while it works and no step is named yet. */
  working: string
  /** hc-1107: while it is writing its answer. */
  replying: string
  /** hc-1107: the latest message got no answer because the send failed. */
  sendFailed: string
  inCall: string
  /** Screen readers: the dot beside the assistant row. */
  unread: string
  wechatTitle: string
  wechatBound: string
  wechatUnbound: string
  /** 「快速 · 本月用了 18%」: `percent` is already formatted (「18%」, 「不到 1%」). */
  planUsage: (parts: { percent: string; period: 'month' | 'week'; plan: string }) => string
  /** Used, but under one percent: 「不到 1%」 rather than a misleading 「0%」. */
  underOnePercent: string
  /** hc-1077: the round 「+」 beside search (several assistants). */
  newBot: string
  /** hc-1077: another assistant's engine could not be reached. */
  openBotFailed: (name: string) => string
  /** hc-1077: every pooled engine is mid-turn (hc-1080), so no room to open another. `names` already joined. */
  allBusy: (names: string) => string
  /** Joins the busy assistants' names. */
  nameSeparator: string
}

const en: SingleThreadSidebarCopy = {
  search: 'Search',
  working: 'Working…',
  replying: 'Replying…',
  sendFailed: 'Didn’t send',
  inCall: 'On a call',
  unread: 'New message',
  wechatTitle: 'Find APEX on WeChat',
  wechatBound: 'Connected',
  wechatUnbound: 'Scan once to connect',
  planUsage: ({ percent, period, plan }) => `${plan} · ${percent} used this ${period}`,
  underOnePercent: 'under 1%',
  newBot: 'New assistant',
  openBotFailed: name => `Couldn’t open ${name} right now. Try again in a moment.`,
  allBusy: names => `${names} are all working. Switch once one of them is done.`,
  nameSeparator: ', '
}

const zh: SingleThreadSidebarCopy = {
  search: '搜索',
  working: '在做事…',
  replying: '正在回…',
  sendFailed: '发送失败',
  inCall: '通话中',
  unread: '有新消息',
  wechatTitle: '在微信里找 APEX',
  wechatBound: '已绑定',
  wechatUnbound: '扫一下就绑上',
  planUsage: ({ percent, period, plan }) => `${plan} · ${period === 'week' ? '本周' : '本月'}用了 ${percent}`,
  underOnePercent: '不到 1%',
  newBot: '新建一个助手',
  openBotFailed: name => `暂时打不开「${name}」，稍后再试。`,
  allBusy: names => `${names}都在做事，等其中一个做完再切过来。`,
  nameSeparator: '、'
}

const zhHant: SingleThreadSidebarCopy = {
  search: '搜尋',
  working: '在做事…',
  replying: '正在回…',
  sendFailed: '傳送失敗',
  inCall: '通話中',
  unread: '有新訊息',
  wechatTitle: '在微信裡找 APEX',
  wechatBound: '已綁定',
  wechatUnbound: '掃一下就綁上',
  planUsage: ({ percent, period, plan }) => `${plan} · ${period === 'week' ? '本週' : '本月'}用了 ${percent}`,
  underOnePercent: '不到 1%',
  newBot: '新建一個助手',
  openBotFailed: name => `暫時打不開「${name}」，稍後再試。`,
  allBusy: names => `${names}都在做事，等其中一個做完再切過來。`,
  nameSeparator: '、'
}

export const SINGLE_THREAD_SIDEBAR_COPY: Readonly<Record<Locale, SingleThreadSidebarCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadSidebarCopy(): SingleThreadSidebarCopy {
  return SINGLE_THREAD_SIDEBAR_COPY[useI18n().locale]
}

/** 「18%」, 「不到 1%」, 「125%」: whole percents, never a 0% for usage that exists. */
export function formatUsedPercent(ratio: number, copy: Pick<SingleThreadSidebarCopy, 'underOnePercent'>): string {
  if (ratio > 0 && ratio < 0.01) {
    return copy.underOnePercent
  }

  // The cloud rounds the ratio to 4 places; going through basis points keeps 0.29 at 29%, not 28%.
  return `${Math.floor(Math.round(ratio * 10_000) / 100)}%`
}
