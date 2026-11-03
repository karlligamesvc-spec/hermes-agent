/**
 * Copy for the APEX sign-in screen: refusals that retrying cannot fix, and
 * hc-1110's way back from a sign-in asked for while still signed in.
 *
 * Kept beside the main catalogs instead of inside them, like model-tier.ts: the
 * four catalog files are past the code-health size cap (they may only shrink).
 * zh, zh-hant, en and ja are complete; ar falls back to en like any missing key.
 */

import { isSingleThreadMode } from '@/store/single-thread'

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface ManagedSignInCopy {
  /** hc-1110: leaves a re-sign-in for where the user was, still signed in (or still expired). */
  back: string
  /** provision-key answered 409 `desktop_device_key_limit_reached` for this new install. */
  deviceLimitReached: string
}

const en: ManagedSignInCopy = {
  back: 'Back',
  deviceLimitReached:
    'This account is already signed in on the maximum number of computers. Sign out of APEX on one of them, then sign in here.'
}

const zh: ManagedSignInCopy = {
  back: '返回',
  deviceLimitReached: '这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。'
}

const zhHant: ManagedSignInCopy = {
  back: '返回',
  deviceLimitReached: '這個帳戶登入的電腦數已達上限。請先在其中一台電腦的 APEX 裡登出，再回到這裡登入。'
}

const ja: ManagedSignInCopy = {
  back: '戻る',
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

/** The sign-in screen's copy in the window's language. */
export function useManagedSignInCopy(): ManagedSignInCopy {
  return MANAGED_SIGN_IN_COPY[useI18n().locale] ?? en
}

/** hc-1133: the toasts on the way through a sign-in, which were English in every language. */
export interface SignInToastCopy {
  /** Any APEX sign-in that reached the end, first or again. */
  readyTitle: string
  readyMessage: string
  /** The engine did not answer as the gateway reopened: at launch, and after a sign-out restarts it. */
  runtimeNotReadyTitle: string
  runtimeNotReadyMessage: string
}

const toastsEn: SignInToastCopy = {
  readyTitle: 'APEX is ready',
  readyMessage: 'APEX connected.',
  runtimeNotReadyTitle: 'Runtime not ready',
  runtimeNotReadyMessage:
    'Hermes Desktop could not verify the running backend on startup. Some features may be unavailable until the gateway is reachable.'
}

const toastsZh: SignInToastCopy = {
  readyTitle: '登录成功',
  readyMessage: 'APEX 准备好了。',
  runtimeNotReadyTitle: 'APEX 还没准备好',
  runtimeNotReadyMessage: '启动时没能确认后台在运行。连上之前，部分功能可能用不了。'
}

const toastsZhHant: SignInToastCopy = {
  readyTitle: '登入成功',
  readyMessage: 'APEX 準備好了。',
  runtimeNotReadyTitle: 'APEX 還沒準備好',
  runtimeNotReadyMessage: '啟動時沒能確認背景服務在執行。連上之前，部分功能可能用不了。'
}

const SIGN_IN_TOASTS: Readonly<Record<Locale, SignInToastCopy>> = {
  ar: toastsEn,
  en: toastsEn,
  ja: toastsEn,
  zh: toastsZh,
  'zh-hant': toastsZhHant
}

/**
 * Product mode says these in the window's language. Developer mode and switch off
 * keep the English they always had, in every language (account-plan-identity.test.tsx).
 */
export function signInToastsNow(): SignInToastCopy {
  return isSingleThreadMode() ? (SIGN_IN_TOASTS[getRuntimeI18nLocale()] ?? toastsEn) : toastsEn
}
