/**
 * Copy for what the relay-key recovery tells the user after a send the relay
 * refused (store/managed-recovery.ts): the key healed, or a sign-in is needed.
 *
 * hc-1110: these lines were looked up under `managedRecovery.*`, keys no catalog
 * ever had, so the toasts and the sign-in screen's notice showed the dotted key.
 * Kept beside the main catalogs instead of inside them, like managed-sign-in.ts:
 * the catalog files are past the code-health size cap (they may only shrink).
 * zh, zh-hant, en and ja are complete; ar falls back to en like any missing key.
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface ManagedRecoveryCopy {
  /** Toast title when a fresh key was applied. */
  healedTitle: string
  /** Its message when the failed turn is the one on screen and is being sent again. */
  healedRetrying: string
  /** Its message when the failed turn was elsewhere and is not resent. */
  healedResend: string
  /** Toast title when no fresh key could be had. */
  signInRequiredTitle: string
  signInRequiredMessage: string
  /** The line above the sign-in screen's buttons for that case. */
  signInRequiredReason: string
}

const en: ManagedRecoveryCopy = {
  healedTitle: 'Reconnected',
  healedRetrying: 'Your sign-in was refreshed. Sending your message again.',
  healedResend: 'Your sign-in was refreshed. Send your last message again.',
  signInRequiredTitle: 'Sign in again',
  signInRequiredMessage: 'This message wasn’t sent. Sign in again, then send it once more.',
  signInRequiredReason:
    'Your sign-in has expired, so your last message wasn’t sent. Sign in again, then send it once more.'
}

const zh: ManagedRecoveryCopy = {
  healedTitle: '已重新连接',
  healedRetrying: '登录凭据已自动更新，正在重新发送这条消息。',
  healedResend: '登录凭据已自动更新，请再发一次刚才那条消息。',
  signInRequiredTitle: '需要重新登录',
  signInRequiredMessage: '这条消息没有发出去。重新登录后再发一次。',
  signInRequiredReason: '登录已失效，刚才那条消息没有发出去。重新登录后再发一次。'
}

const zhHant: ManagedRecoveryCopy = {
  healedTitle: '已重新連線',
  healedRetrying: '登入憑證已自動更新，正在重新傳送這則訊息。',
  healedResend: '登入憑證已自動更新，請再傳一次剛才那則訊息。',
  signInRequiredTitle: '需要重新登入',
  signInRequiredMessage: '這則訊息沒有送出。重新登入後再傳一次。',
  signInRequiredReason: '登入已失效，剛才那則訊息沒有送出。重新登入後再傳一次。'
}

const ja: ManagedRecoveryCopy = {
  healedTitle: '再接続しました',
  healedRetrying: 'ログイン情報を自動で更新しました。このメッセージをもう一度送信しています。',
  healedResend: 'ログイン情報を自動で更新しました。さきほどのメッセージをもう一度送ってください。',
  signInRequiredTitle: 'もう一度ログインしてください',
  signInRequiredMessage: 'このメッセージは送信されませんでした。もう一度ログインしてから送ってください。',
  signInRequiredReason:
    'ログインの有効期限が切れたため、さきほどのメッセージは送信されませんでした。もう一度ログインしてから送ってください。'
}

export const MANAGED_RECOVERY_COPY: Readonly<Record<Locale, ManagedRecoveryCopy>> = {
  ar: en,
  en,
  ja,
  zh,
  'zh-hant': zhHant
}

/** Recovery copy outside React (the recovery store runs between renders). */
export function managedRecoveryCopyNow(): ManagedRecoveryCopy {
  return MANAGED_RECOVERY_COPY[getRuntimeI18nLocale()] ?? en
}
