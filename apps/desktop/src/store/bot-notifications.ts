/**
 * hc-1077: with several assistants on, a system notification about one
 * assistant's conversation says whose it is — 「小红书文案 · 回复就绪」 — since
 * any of them may finish, ask or wait for approval in the background. A
 * conversation that is no assistant's thread, and every notification with one
 * assistant, keep their title as it was. Installed through the
 * notification-title seam by the single-thread shell (use-multi-bot-shell.ts).
 */

import { multiBotCopyNow } from '@/i18n/multi-bot'

import { $botRoster, botFor, isMultiBotMode } from './single-thread-bots'
import { profileOfThreadStoredId } from './single-thread-presence'

export function botNotificationTitle(title: string, storedSessionId: null | string | undefined): string {
  if (!isMultiBotMode()) {
    return title
  }

  const profile = profileOfThreadStoredId(storedSessionId)

  return profile ? multiBotCopyNow().notificationTitle(botFor($botRoster.get(), profile).name, title) : title
}
