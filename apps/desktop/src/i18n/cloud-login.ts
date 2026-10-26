/**
 * Copy for the 「登录已失效」 card the sidebar shows when the cloud rejects the
 * stored login JWT while chat still works (hc-1073). The card's first line is
 * the existing t.auth.account.sessionExpiredTitle.
 *
 * Kept beside the main catalogs instead of inside them, like account-team.ts:
 * the catalog files are past the code-health size cap (they may only shrink).
 * zh, zh-hant and en are complete; ja and ar fall back to en like any missing key.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface CloudLoginCopy {
  /** The card's second line: what stopped, and that a click signs in again. */
  action: string
  /** The notice the sign-in panel opens with after the click. */
  reason: string
}

const en: CloudLoginCopy = {
  action: 'Skills not updating · Sign in again',
  reason: 'Your sign-in has expired, so skills and plugins stopped updating. Sign in again and they update right away.'
}

const zh: CloudLoginCopy = {
  action: '技能和插件没更新，点此重新登录',
  reason: '登录已失效，技能和插件一直没有更新。重新登录后会马上更新。'
}

const zhHant: CloudLoginCopy = {
  action: '技能和外掛沒更新，點此重新登入',
  reason: '登入已失效，技能和外掛一直沒有更新。重新登入後會馬上更新。'
}

export const CLOUD_LOGIN_COPY: Readonly<Record<Locale, CloudLoginCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** The card's copy in the window's language. */
export function useCloudLoginCopy(): CloudLoginCopy {
  return CLOUD_LOGIN_COPY[useI18n().locale] ?? en
}
