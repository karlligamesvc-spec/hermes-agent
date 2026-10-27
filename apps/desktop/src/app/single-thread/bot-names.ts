/**
 * hc-1077: single-thread lines outside React that say 「APEX」 about the
 * assistant, read with the name of the assistant on screen while several are
 * on (store/single-thread-bots.ts `withBotName`), and exactly as written
 * otherwise; and what an assistant's thread is called where a list shows it.
 */

import { multiBotCopyNow } from '@/i18n/multi-bot'
import { singleThreadCopyNow } from '@/i18n/single-thread'
import { sessionTitle } from '@/lib/chat-runtime'
import { MAIN_THREAD_TITLE } from '@/store/main-thread'
import { $botRoster, botFor, currentBotNameNow, isMultiBotMode, withBotName } from '@/store/single-thread-bots'
import type { SessionInfo } from '@/types/hermes'

/** `/model` in single-thread mode: 「不用选模型，APEX 会按要做的事自己安排。」 */
export function modelSlashHintNow(): string {
  return withBotName(singleThreadCopyNow().modelSlashHint, currentBotNameNow())
}

/** The thread's stored title, or a compression tip's 「APEX 主线 #2」. */
const THREAD_TITLE = new RegExp(`^${MAIN_THREAD_TITLE}(?: #\\d+)?$`)

/**
 * A session's name in the command palette (which lists every profile's). With
 * several assistants on, each assistant's thread is titled 「APEX 主线」 —
 * the identity key, not copy — so it reads 「和 小红书文案 的对话」 instead.
 * Everything else, and every row with one assistant, keeps its title.
 */
export function paletteSessionTitle(session: SessionInfo): string {
  const title = sessionTitle(session)

  if (!isMultiBotMode() || !THREAD_TITLE.test(session.title?.trim() ?? '')) {
    return title
  }

  return multiBotCopyNow().threadLabel(botFor($botRoster.get(), session.profile || 'default').name)
}
