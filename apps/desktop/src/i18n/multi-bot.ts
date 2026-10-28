/**
 * hc-1077: the words that say which assistant something belongs to, once
 * several are on — a system notification's title, an assistant's
 * conversation in the command palette, the settings page, and the note that
 * the tier is the account's.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap. Each locale is a whole typed object, so a missing
 * zh string is a type error; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface MultiBotCopy {
  /** A system notification about one assistant's conversation: 「小红书文案 · 回复就绪」. */
  notificationTitle: (name: string, title: string) => string
  /** An assistant's conversation in the command palette (its stored title is the identity key 「APEX 主线」). */
  threadLabel: (name: string) => string
  /** The settings page's title: whose settings these pages change. */
  settingsTitle: (name: string) => string
  /** Over the model / tier page while another assistant is on screen: it changes the account's (APEX's). */
  sharedTierNote: (apexName: string) => string
}

const en: MultiBotCopy = {
  notificationTitle: (name, title) => `${name} · ${title}`,
  threadLabel: name => `Chat with ${name}`,
  settingsTitle: name => `${name} settings`,
  sharedTierNote: apexName =>
    `All assistants share one model tier, set here for the account (${apexName}). The other settings are this assistant’s own.`
}

const zh: MultiBotCopy = {
  notificationTitle: (name, title) => `${name} · ${title}`,
  threadLabel: name => `和 ${name} 的对话`,
  settingsTitle: name => `${name} 的设置`,
  sharedTierNote: apexName => `档位所有助手共用，这里改的是账户的(跟 ${apexName} 一样)。别的设置是这个助手自己的。`
}

const zhHant: MultiBotCopy = {
  notificationTitle: (name, title) => `${name} · ${title}`,
  threadLabel: name => `和 ${name} 的對話`,
  settingsTitle: name => `${name} 的設定`,
  sharedTierNote: apexName => `檔位所有助手共用，這裡改的是帳戶的(跟 ${apexName} 一樣)。別的設定是這個助手自己的。`
}

export const MULTI_BOT_COPY: Readonly<Record<Locale, MultiBotCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useMultiBotCopy(): MultiBotCopy {
  return MULTI_BOT_COPY[useI18n().locale]
}

/** For code outside React (notifications, the command palette's rows). */
export function multiBotCopyNow(): MultiBotCopy {
  return MULTI_BOT_COPY[getRuntimeI18nLocale()]
}
