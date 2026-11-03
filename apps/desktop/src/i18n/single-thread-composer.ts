/**
 * Copy for hc-1060, the single-thread composer as prototype v2 draws it: the
 * fixed placeholder, the dictation mic beside the input (⌘D), and the small
 * 「停」 on the activity line that stands in for the composer's Stop button.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface SingleThreadComposerCopy {
  /** The input's placeholder and its accessible name, fixed (no rotating starters). */
  placeholder: string
  /** The mic beside the input (tap to start and tap again, or hold and let go),
   *  and its ⌘D row in the shortcut table. */
  dictate: string
  /** The small stop on the activity line. */
  stop: string
  /** Its accessible name and tooltip. */
  stopLabel: string
}

const en: SingleThreadComposerCopy = {
  placeholder: 'Message APEX',
  dictate: 'Dictate',
  stop: 'Stop',
  stopLabel: 'Stop what APEX is doing'
}

const zh: SingleThreadComposerCopy = {
  placeholder: '给 APEX 发消息',
  dictate: '听写',
  stop: '停',
  stopLabel: '让 APEX 停下手上的事'
}

const zhHant: SingleThreadComposerCopy = {
  placeholder: '給 APEX 發訊息',
  dictate: '聽寫',
  stop: '停',
  stopLabel: '讓 APEX 停下手上的事'
}

export const SINGLE_THREAD_COMPOSER_COPY: Readonly<Record<Locale, SingleThreadComposerCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadComposerCopy(): SingleThreadComposerCopy {
  return SINGLE_THREAD_COMPOSER_COPY[useI18n().locale]
}
