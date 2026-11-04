/**
 * hc-1142: what product mode says while 「退出登录」 runs and when it does not
 * finish. Every failure says the computer is still signed in (the server never
 * confirmed a revoke, so nothing local was cleared) and why, and offers the one
 * step that can help: try again, or sign in again when the login has expired.
 * Kept beside the main catalogs, like managed-recovery.ts: those files are past
 * the code-health size cap. zh, zh-hant, en and ja are complete; ar reads en.
 */

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

/** Why a sign-out did not finish, as far as the window can tell from main's answer. */
export type SignOutFailureKind = 'busy' | 'expired' | 'local' | 'network'

export interface SignOutCopy {
  /** The cover from the click until the login screen. */
  signingOut: string
  failed: Record<SignOutFailureKind, string>
  retry: string
  signInAgain: string
}

const en: SignOutCopy = {
  signingOut: 'Signing out…',
  failed: {
    network:
      'Couldn’t confirm the sign-out with the APEX server, so this computer is still signed in. Check your connection and try again.',
    expired:
      'Your sign-in has expired, so the server couldn’t confirm the sign-out. This computer is still signed in. Sign in again, then sign out.',
    busy: 'APEX is busy updating its settings, so this computer is still signed in. Wait a few seconds and try again.',
    local: 'The sign-in stored on this computer couldn’t be removed, so it is still signed in. Try again.'
  },
  retry: 'Try again',
  signInAgain: 'Sign in again'
}

const zh: SignOutCopy = {
  signingOut: '正在退出登录…',
  failed: {
    network: '没能和 APEX 服务器确认退出，这台电脑仍是登录状态。检查网络后重试。',
    expired: '登录已过期，服务器没法确认退出，这台电脑仍是登录状态。请先重新登录，再退出。',
    busy: 'APEX 正在更新设置，这台电脑仍是登录状态。稍等几秒再重试。',
    local: '这台电脑上的登录信息没能删除，仍是登录状态。请重试。'
  },
  retry: '重试',
  signInAgain: '重新登录'
}

const zhHant: SignOutCopy = {
  signingOut: '正在登出…',
  failed: {
    network: '沒能和 APEX 伺服器確認登出，這台電腦仍是登入狀態。檢查網路後重試。',
    expired: '登入已過期，伺服器沒法確認登出，這台電腦仍是登入狀態。請先重新登入，再登出。',
    busy: 'APEX 正在更新設定，這台電腦仍是登入狀態。稍等幾秒再重試。',
    local: '這台電腦上的登入資訊沒能刪除，仍是登入狀態。請重試。'
  },
  retry: '重試',
  signInAgain: '重新登入'
}

const ja: SignOutCopy = {
  signingOut: 'ログアウトしています…',
  failed: {
    network:
      'APEX サーバーでログアウトを確認できなかったため、このコンピューターはログインしたままです。接続を確認してもう一度お試しください。',
    expired:
      'ログインの有効期限が切れているため、サーバーでログアウトを確認できませんでした。このコンピューターはログインしたままです。もう一度ログインしてからログアウトしてください。',
    busy: 'APEX が設定を更新中のため、このコンピューターはログインしたままです。数秒待ってからもう一度お試しください。',
    local: 'このコンピューターのログイン情報を削除できなかったため、ログインしたままです。もう一度お試しください。'
  },
  retry: 'もう一度試す',
  signInAgain: 'もう一度ログイン'
}

export const SIGN_OUT_COPY: Readonly<Record<Locale, SignOutCopy>> = {
  ar: en,
  en,
  ja,
  zh,
  'zh-hant': zhHant
}

export function useSignOutCopy(): SignOutCopy {
  return SIGN_OUT_COPY[useI18n().locale] ?? en
}

/** Sign-out copy outside React (the failure toast is raised after the menu has closed). */
export function signOutCopyNow(): SignOutCopy {
  return SIGN_OUT_COPY[getRuntimeI18nLocale()] ?? en
}

/**
 * main's answer (`hermes:managed:signOut`) as a reason. A 401/403 is the login
 * token the revoke is sent with; MODEL_* is the local engine still settling a
 * model change (the fence); SIGN_OUT_CLEAR_FAILED is the credential file. The
 * rest, an unreachable or erroring server or an answer that did not confirm the
 * revoke, cannot be told apart from here and reads as the network.
 */
export function signOutFailureKind(outcome: { message?: string; statusCode?: number }): SignOutFailureKind {
  const message = String(outcome.message ?? '')

  if (outcome.statusCode === 401 || outcome.statusCode === 403 || message === 'SIGN_OUT_REQUIRES_SIGN_IN') {
    return 'expired'
  }

  if (message.startsWith('MODEL_')) {
    return 'busy'
  }

  return message === 'SIGN_OUT_CLEAR_FAILED' ? 'local' : 'network'
}
