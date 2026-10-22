/**
 * Copy for APEX sign-in refusals that retrying cannot fix.
 *
 * Kept beside the main catalogs instead of inside them, like model-tier.ts: the
 * four catalog files are past the code-health size cap (they may only shrink).
 * zh, zh-hant, en and ja are complete; ar falls back to en like any missing key.
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface ManagedSignInCopy {
  /** provision-key answered 409 `desktop_device_key_limit_reached` for this new install. */
  deviceLimitReached: string
}

const en: ManagedSignInCopy = {
  deviceLimitReached:
    'This account is already signed in on the maximum number of computers. Sign out of APEX on one of them, then sign in here.'
}

const zh: ManagedSignInCopy = {
  deviceLimitReached: '这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。'
}

const zhHant: ManagedSignInCopy = {
  deviceLimitReached: '這個帳戶登入的電腦數已達上限。請先在其中一台電腦的 APEX 裡登出，再回到這裡登入。'
}

const ja: ManagedSignInCopy = {
  deviceLimitReached:
    'このアカウントでログインしているパソコンが上限に達しています。いずれかのパソコンの APEX でログアウトしてから、ここでログインしてください。'
}

export const MANAGED_SIGN_IN_COPY: Readonly<Record<Locale, ManagedSignInCopy>> = {
  ar: en,
  en,
  ja,
  zh,
  'zh-hant': zhHant
}

/** Sign-in refusal copy outside React (the onboarding store maps Native markers). */
export function managedSignInCopyNow(): ManagedSignInCopy {
  return MANAGED_SIGN_IN_COPY[getRuntimeI18nLocale()] ?? en
}
