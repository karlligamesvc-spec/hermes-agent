/**
 * Copy for hc-1186: a scheduled job's result that comes back into the chat it was made in.
 *
 * The engine posts the result as a `cron_result` row (apex_overlay/cron_desktop_delivery.py); the chat shows
 * it as a card and, while the user is away, the OS shows a notification that opens that chat.
 *
 * Kept beside the main catalogs instead of inside them: those files are past the code-health size cap. Each
 * locale is a whole typed object, so a missing zh string is a type error; zh, zh-hant and en are complete,
 * ja and ar read en.
 */

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface CronResultCopy {
  /** The card's title and the transcript line: the job's name, and whether it ran. */
  title: (jobName: string, failed: boolean) => string
  /** The card's button that opens the job's own run conversation. */
  openRun: string
  /** OS notification titles, while the user is away from APEX. */
  notifyDone: string
  notifyFailed: string
}

const zh: CronResultCopy = {
  title: (jobName, failed) => (failed ? `定时任务「${jobName}」没跑成` : `定时任务「${jobName}」的结果`),
  openRun: '查看这次运行',
  notifyDone: '定时任务有结果了',
  notifyFailed: '定时任务没跑成'
}

const zhHant: CronResultCopy = {
  title: (jobName, failed) => (failed ? `定時任務「${jobName}」沒跑成` : `定時任務「${jobName}」的結果`),
  openRun: '查看這次執行',
  notifyDone: '定時任務有結果了',
  notifyFailed: '定時任務沒跑成'
}

const en: CronResultCopy = {
  title: (jobName, failed) => (failed ? `Scheduled job "${jobName}" didn't run` : `Scheduled job "${jobName}" result`),
  openRun: 'View this run',
  notifyDone: 'A scheduled job has a result',
  notifyFailed: "A scheduled job didn't run"
}

export const CRON_RESULT_COPY: Readonly<Record<Locale, CronResultCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useCronResultCopy(): CronResultCopy {
  return CRON_RESULT_COPY[useI18n().locale] ?? en
}

/** For code outside React (transcript hydration, notifications): the app's active locale. */
export function cronResultCopyNow(): CronResultCopy {
  return CRON_RESULT_COPY[getRuntimeI18nLocale()] ?? en
}
