/**
 * hc-1101: the transcript's action words, said plainly in single-thread
 * product mode.
 *
 * Upstream names a message's actions in developer terms: 「恢复检查点 — 从此提示
 * 重新运行」, 「恢复上一个检查点」, 「前进」, 「刷新」. In single-thread mode the
 * same keys read 从这条重来, 上一版 / 下一版, 重新回答
 * (i18n/single-thread-messages.ts), so every surface that reads them changes
 * together:
 * - the user bubble: its rail and its version switcher;
 * - the start-over confirm (thread/index.tsx);
 * - the reply's action bar.
 *
 * Anywhere else this is `t.assistant.thread` itself (the same object), so the
 * switch-off transcript is unchanged.
 */

import { useMemo } from 'react'

import { type Translations, useI18n } from '@/i18n'
import { useSingleThreadMessageCopy } from '@/i18n/single-thread-messages'
import { useSingleThreadMode } from '@/store/single-thread'

export type ThreadCopy = Translations['assistant']['thread']

export function useThreadCopy(): ThreadCopy {
  const { t } = useI18n()
  const words = useSingleThreadMessageCopy()
  const singleThread = useSingleThreadMode()

  return useMemo(
    () =>
      singleThread
        ? {
            ...t.assistant.thread,
            editMessage: words.edit,
            goForward: words.nextVersion,
            refresh: words.reanswer,
            restoreBody: words.redoBody,
            // The version switcher's "previous" label; the rail's start-over button reads restoreFromHere.
            restoreCheckpoint: words.previousVersion,
            restoreConfirm: words.redoConfirm,
            restoreFromHere: words.redo,
            restoreNext: words.nextVersionTitle,
            restorePrevious: words.previousVersionTitle,
            restoreTitle: words.redoTitle
          }
        : t.assistant.thread,
    [singleThread, t, words]
  )
}
