/**
 * Copy around a creator tip (hc-995) in the process area. Kept beside the
 * process block (like i18n/*-process.ts) because the locale trees are at their
 * size cap, and typed per locale so a missing key is a compile error, not an
 * English fallback. The tip's own words come from the cloud's catalog, which
 * carries Chinese and English.
 */

import type { DesktopCreatorTip } from '@/global'
import type { Locale } from '@/i18n/types'

export interface CreatorTipCopy {
  /** The word before the tip. */
  label: string
  /** The ✕ that closes this turn's tip. */
  close: string
  /** Turns every tip off (the 应用内提示 switch). */
  turnOffAll: string
  /** Shown in that turn afterwards; `settingsPath` is where the switch lives, in Settings' own words. */
  turnedOff: (settingsPath: string) => string
}

export const CREATOR_TIP_COPY: Record<Locale, CreatorTipCopy> = {
  zh: {
    label: '小贴士',
    close: '关掉这条贴士',
    turnOffAll: '不再显示小贴士',
    turnedOff: path => `已关掉小贴士。想再看，到 ${path} 打开。`
  },
  'zh-hant': {
    label: '小貼士',
    close: '關掉這條貼士',
    turnOffAll: '不再顯示小貼士',
    turnedOff: path => `已關掉小貼士。想再看，到 ${path} 開啟。`
  },
  en: {
    label: 'Tip',
    close: 'Close this tip',
    turnOffAll: 'Stop showing tips',
    turnedOff: path => `Tips are off. Turn them back on in ${path}.`
  },
  ja: {
    label: 'ヒント',
    close: 'このヒントを閉じる',
    turnOffAll: 'ヒントを表示しない',
    turnedOff: path => `ヒントをオフにしました。${path} でオンに戻せます。`
  },
  ar: {
    label: 'نصيحة',
    close: 'إغلاق هذه النصيحة',
    turnOffAll: 'إيقاف عرض النصائح',
    turnedOff: path => `تم إيقاف النصائح. يمكنك تشغيلها من ${path}.`
  }
}

/** Chinese screens read the tip in Chinese; every other locale in English. */
export function creatorTipText(tip: DesktopCreatorTip, locale: Locale): string {
  return locale === 'zh' || locale === 'zh-hant' ? tip.text.zh : tip.text.en
}
