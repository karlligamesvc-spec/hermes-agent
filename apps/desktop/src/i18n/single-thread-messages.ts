/**
 * Copy for hc-1101 单线对话的消息操作: the hover rail beside your message
 * (改一下, 从这条重来), the confirm before starting over, the reply's
 * 「重新回答」, 「仍在发送中」 under a send the gateway has not taken yet, and the
 * time at the top of a message's right-click menu.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en (as
 * single-thread-chat.ts does).
 */

import { useI18n } from './context'
import { SINGLE_THREAD_CHAT_COPY } from './single-thread-chat'
import type { Locale } from './types'

export interface SingleThreadMessageCopy {
  /** The rail's edit button: a click on the bubble no longer edits. */
  edit: string
  /** The rail's start-over button (upstream's restore checkpoint). */
  redo: string
  redoTitle: string
  redoBody: string
  redoConfirm: string
  /** The version switcher under a message that has more than one. */
  previousVersion: string
  previousVersionTitle: string
  nextVersion: string
  nextVersionTitle: string
  /** The reply's regenerate button (upstream's 「刷新」). */
  reanswer: string
  /** Under your message while the gateway has not taken the send. */
  stillSending: string
}

const en: SingleThreadMessageCopy = {
  edit: 'Edit',
  redo: 'Start over from here',
  redoTitle: 'Start over from this message?',
  redoBody: 'Everything after this message is cleared, and this message is answered again.',
  redoConfirm: 'Start over',
  previousVersion: 'Previous',
  previousVersionTitle: 'See the previous version',
  nextVersion: 'Next',
  nextVersionTitle: 'See the next version',
  reanswer: 'Answer again',
  stillSending: 'Still sending'
}

const zh: SingleThreadMessageCopy = {
  edit: '改一下',
  redo: '从这条重来',
  redoTitle: '从这条重新开始？',
  redoBody: '这条之后的对话会清掉，再重新回答这条。',
  redoConfirm: '重新开始',
  previousVersion: '上一版',
  previousVersionTitle: '看上一版',
  nextVersion: '下一版',
  nextVersionTitle: '看下一版',
  reanswer: '重新回答',
  stillSending: '仍在发送中'
}

const zhHant: SingleThreadMessageCopy = {
  edit: '改一下',
  redo: '從這條重來',
  redoTitle: '從這條重新開始？',
  redoBody: '這條之後的對話會清掉，再重新回答這條。',
  redoConfirm: '重新開始',
  previousVersion: '上一版',
  previousVersionTitle: '看上一版',
  nextVersion: '下一版',
  nextVersionTitle: '看下一版',
  reanswer: '重新回答',
  stillSending: '仍在傳送中'
}

export const SINGLE_THREAD_MESSAGE_COPY: Readonly<Record<Locale, SingleThreadMessageCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadMessageCopy(): SingleThreadMessageCopy {
  return SINGLE_THREAD_MESSAGE_COPY[useI18n().locale]
}

const twoDigits = (value: number) => String(value).padStart(2, '0')

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * When a message was sent, for the top of its right-click menu: 「今天 09:05」,
 * 「昨天 21:40」, else the date line's own wording with the time
 * (「10 月 21 日 周二 14:20」), in the thread's 24-hour clock.
 */
export function messageTimeLabel(locale: Locale, at: Date, now: Date): string {
  const chat = SINGLE_THREAD_CHAT_COPY[locale]
  const hhmm = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)

  if (sameDay(at, now) || sameDay(at, yesterday)) {
    return chat.turnTime({ day: sameDay(at, now) ? 'today' : 'yesterday', hhmm })
  }

  const year = at.getFullYear() === now.getFullYear() ? null : at.getFullYear()
  const date = chat.day({ day: at.getDate(), month: at.getMonth() + 1, weekday: at.getDay(), year })

  return `${date} ${hhmm}`
}
