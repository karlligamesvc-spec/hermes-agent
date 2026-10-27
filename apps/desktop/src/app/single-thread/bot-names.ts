/**
 * hc-1077: single-thread lines outside React that say 「APEX」 about the
 * assistant, read with the name of the assistant on screen while several are
 * on (store/single-thread-bots.ts `withBotName`), and exactly as written
 * otherwise.
 */

import { singleThreadCopyNow } from '@/i18n/single-thread'
import { currentBotNameNow, withBotName } from '@/store/single-thread-bots'

/** `/model` in single-thread mode: 「不用选模型，APEX 会按要做的事自己安排。」 */
export function modelSlashHintNow(): string {
  return withBotName(singleThreadCopyNow().modelSlashHint, currentBotNameNow())
}
