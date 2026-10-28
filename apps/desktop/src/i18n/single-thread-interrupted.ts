/**
 * hc-1100: the line under a turn that quitting APEX cut off, shown when the
 * conversation is opened again.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap. Each locale is a whole typed object, so a missing
 * zh string is a type error; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface SingleThreadInterruptedCopy {
  /** What happened, said first. */
  interrupted: string
  /** The button when the turn had not reached a step yet (otherwise the step's own three buttons). */
  goOn: string
  /** What 「接着做」 sends. */
  goOnMessage: string
}

const zh: SingleThreadInterruptedCopy = {
  interrupted: '上次被打断了：APEX 退出时，这一轮还没做完。',
  goOn: '接着做',
  goOnMessage: '上次退出时被打断了，接着把这件事做完。'
}

const zhHant: SingleThreadInterruptedCopy = {
  interrupted: '上次被打斷了：APEX 結束時，這一輪還沒做完。',
  goOn: '接著做',
  goOnMessage: '上次結束時被打斷了，接著把這件事做完。'
}

const en: SingleThreadInterruptedCopy = {
  interrupted: 'This was cut off last time: APEX quit before it finished.',
  goOn: 'Carry on',
  goOnMessage: 'You were cut off when APEX quit last time. Please carry on and finish this.'
}

export const SINGLE_THREAD_INTERRUPTED_COPY: Readonly<Record<Locale, SingleThreadInterruptedCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadInterruptedCopy(): SingleThreadInterruptedCopy {
  return SINGLE_THREAD_INTERRUPTED_COPY[useI18n().locale] ?? en
}
