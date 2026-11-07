/**
 * Copy for hc-1146 发消息半天没反应: the line above the composer while an
 * assistant's conversation is opening, and the messages sent meanwhile that
 * wait for it (app/single-thread/held-sends-strip.tsx). Each locale is a whole
 * typed object, as in single-thread-chat.ts; ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface HeldSendsCopy {
  /** The conversation of `name` is opening; what is sent now waits for it. */
  opening: (name: string) => string
  /** Under a waiting message, while `name` is still opening. */
  waitsForAssistant: (name: string) => string
  /** Under a waiting message once the assistant is up: the reply to the one before is still coming. */
  waitsForReply: string
  /** The button that takes a waiting message back into the composer. */
  withdraw: string
  /** Its tooltip and accessible name. */
  withdrawHint: string
  /** The list's accessible name. */
  listLabel: string
}

const en: HeldSendsCopy = {
  opening: name => `Waking up ${name}… What you send now goes out as soon as it’s ready.`,
  waitsForAssistant: name => `Sends when ${name} is ready`,
  waitsForReply: 'Sends after the reply above',
  withdraw: 'Don’t send',
  withdrawHint: 'Don’t send this; put it back in the message box',
  listLabel: 'Waiting to send'
}

const zh: HeldSendsCopy = {
  opening: name => `正在唤醒 ${name}…现在发的消息会先排着，接上就发。`,
  waitsForAssistant: name => `${name} 接上后发送`,
  waitsForReply: '上一条回完再发',
  withdraw: '取消发送',
  withdrawHint: '不发了，放回输入框',
  listLabel: '等待发送'
}

const zhHant: HeldSendsCopy = {
  opening: name => `正在喚醒 ${name}…現在發的訊息會先排著，接上就發。`,
  waitsForAssistant: name => `${name} 接上後傳送`,
  waitsForReply: '上一則回完再發',
  withdraw: '取消傳送',
  withdrawHint: '不發了，放回輸入框',
  listLabel: '等待傳送'
}

export const HELD_SENDS_COPY: Readonly<Record<Locale, HeldSendsCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useHeldSendsCopy(): HeldSendsCopy {
  return HELD_SENDS_COPY[useI18n().locale]
}
