/**
 * Copy for hc-1014 单线对话: the thread's first-open greeting, the day / new
 * segment lines, the 「更早的对话」 page and the read-only bar under an older
 * conversation, and the notices a new segment shows.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface SingleThreadChatCopy {
  /** Sidebar row that opens the thread. */
  thread: string
  greeting: string
  greetingHint: string
  /** Between two segments on the same day. */
  newSegment: string
  /** Between days: `month` 1–12, `weekday` 0 = Sunday; `year` only when it is not this year. */
  day: (parts: { day: number; month: number; weekday: number; year: null | number }) => string
  earlierTitle: string
  earlierDescription: string
  earlierEmpty: string
  earlierUntitled: string
  /** The bar that stands in for the composer under an older conversation. */
  readOnlyLine: string
  backToThread: string
  /** A segment is being opened (the runtime summarizes the last one). */
  segmentStarting: string
  /** `/new` or 「从头来」 opened a new segment. */
  restarted: string
  /** A send arrived before the thread was found; it stays in the composer. */
  threadOpening: string
  /** The thread lookup failed; nothing is sent, so no second thread is made. */
  threadUnavailable: string
}

const ZH_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const en: SingleThreadChatCopy = {
  thread: 'Chat',
  greeting: 'Hi, I’m APEX. I help you make short videos.',
  greetingHint:
    'We keep talking in this one conversation, so there is nothing new to open. To change the subject, just say “start over”.',
  newSegment: 'New',
  day: ({ day, month, weekday, year }) =>
    `${EN_WEEKDAYS[weekday] ?? ''}, ${EN_MONTHS[month - 1] ?? ''} ${day}${year === null ? '' : `, ${year}`}`,
  earlierTitle: 'Earlier conversations',
  earlierDescription: 'Conversations from before the single chat. You can read them; new messages go to the main chat.',
  earlierEmpty: 'No earlier conversations.',
  earlierUntitled: 'Untitled conversation',
  readOnlyLine: 'This is an earlier conversation. You can read it here.',
  backToThread: 'Back to the chat',
  segmentStarting: 'Picking up where we left off…',
  restarted: 'OK, I still remember what came before. Starting fresh from here.',
  threadOpening: 'Opening the chat. Send again in a moment.',
  threadUnavailable: 'Can’t reach the chat right now. Your message is still in the box; try again shortly.'
}

const zh: SingleThreadChatCopy = {
  thread: '对话',
  greeting: '你好，我是 APEX，帮你做短视频的。',
  greetingHint: '我们就在这一个对话里聊，不用开新的。想换个话题，直接说「从头来」。',
  newSegment: '新的一段',
  day: ({ day, month, weekday, year }) =>
    `${year === null ? '' : `${year} 年 `}${month} 月 ${day} 日 周${ZH_WEEKDAYS[weekday] ?? ''}`,
  earlierTitle: '更早的对话',
  earlierDescription: '开始用一条对话之前的聊天记录，这里只能看；新消息都发到主对话里。',
  earlierEmpty: '没有更早的对话。',
  earlierUntitled: '未命名的对话',
  readOnlyLine: '这是更早的对话，只能看。',
  backToThread: '回到对话',
  segmentStarting: '正在接上之前的内容…',
  restarted: '好，前面的我记着，从这儿重新来。',
  threadOpening: '正在打开对话，稍等一下再发。',
  threadUnavailable: '暂时连不上对话，消息还在输入框里，稍后再发。'
}

const zhHant: SingleThreadChatCopy = {
  thread: '對話',
  greeting: '你好，我是 APEX，幫你做短影音的。',
  greetingHint: '我們就在這一個對話裡聊，不用開新的。想換個話題，直接說「從頭來」。',
  newSegment: '新的一段',
  day: ({ day, month, weekday, year }) =>
    `${year === null ? '' : `${year} 年 `}${month} 月 ${day} 日 週${ZH_WEEKDAYS[weekday] ?? ''}`,
  earlierTitle: '更早的對話',
  earlierDescription: '開始用一條對話之前的聊天記錄，這裡只能看；新訊息都發到主對話裡。',
  earlierEmpty: '沒有更早的對話。',
  earlierUntitled: '未命名的對話',
  readOnlyLine: '這是更早的對話，只能看。',
  backToThread: '回到對話',
  segmentStarting: '正在接上之前的內容…',
  restarted: '好，前面的我記著，從這裡重新來。',
  threadOpening: '正在打開對話，稍等一下再發。',
  threadUnavailable: '暫時連不上對話，訊息還在輸入框裡，稍後再發。'
}

export const SINGLE_THREAD_CHAT_COPY: Readonly<Record<Locale, SingleThreadChatCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadChatCopy(): SingleThreadChatCopy {
  return SINGLE_THREAD_CHAT_COPY[useI18n().locale]
}

/** For code outside React (the composer middleware, notices). */
export function singleThreadChatCopyNow(): SingleThreadChatCopy {
  return SINGLE_THREAD_CHAT_COPY[getRuntimeI18nLocale()]
}
