/**
 * Copy for single-thread mode (hc-1015 「只有问题和回复」): the activity line at
 * the foot of the conversation and the 「看过程」 line under an answer. What a
 * step is called comes from the process copy (`*-process.ts`), so the two
 * surfaces always name a step the same way.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error; zh, zh-hant and en are
 * complete, ja and ar read en.
 */

import type { WaitingAsk } from '@/store/thread-signals'

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface SingleThreadCopy {
  /** The activity line's accessible name. */
  activity: string
  hideProcess: string
  /** `/model` or `/moa` typed in single-thread mode: nothing runs. */
  modelSlashHint: string
  showProcess: string
  /** The activity line while a question card waits on the user to choose. */
  waitingForYou: string
  /** hc-1107: while an approval, the relay confirm card or another yes/no waits on the user. */
  waitingToConfirm: string
}

/** hc-1107: the words for what a waiting turn asks — a choice reads 「等你决定」, a yes/no 「等你确认」. */
export function waitingLine(copy: SingleThreadCopy, ask: WaitingAsk): string {
  return ask === 'confirm' ? copy.waitingToConfirm : copy.waitingForYou
}

const en: SingleThreadCopy = {
  activity: 'What APEX is doing',
  hideProcess: 'Hide the process',
  modelSlashHint: 'No model to pick: APEX sorts that out for each job.',
  showProcess: 'See the process',
  waitingForYou: 'Waiting for you',
  waitingToConfirm: 'Needs your OK'
}

const zh: SingleThreadCopy = {
  activity: 'APEX 在做的事',
  hideProcess: '收起过程',
  modelSlashHint: '不用选模型，APEX 会按要做的事自己安排。',
  showProcess: '看过程',
  waitingForYou: '等你决定',
  waitingToConfirm: '等你确认'
}

const zhHant: SingleThreadCopy = {
  activity: 'APEX 在做的事',
  hideProcess: '收起過程',
  modelSlashHint: '不用選模型，APEX 會按要做的事自己安排。',
  showProcess: '看過程',
  waitingForYou: '等你決定',
  waitingToConfirm: '等你確認'
}

export const SINGLE_THREAD_COPY: Readonly<Record<Locale, SingleThreadCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadCopy(): SingleThreadCopy {
  return SINGLE_THREAD_COPY[useI18n().locale] ?? en
}

/** Outside React (slash output). */
export function singleThreadCopyNow(): SingleThreadCopy {
  return SINGLE_THREAD_COPY[getRuntimeI18nLocale()] ?? en
}
