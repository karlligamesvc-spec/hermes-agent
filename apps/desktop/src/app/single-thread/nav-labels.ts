import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { useSingleThreadMode } from '@/store/single-thread'

/** hc-1014: the sidebar/account-menu labels, with 历史会话 read as 「更早的对话」 in single-thread product mode. */
export function useSingleThreadNavLabels(nav: Record<string, string>): Record<string, string> {
  const singleThread = useSingleThreadMode()
  const copy = useSingleThreadChatCopy()

  return singleThread ? { ...nav, history: copy.earlierTitle } : nav
}
