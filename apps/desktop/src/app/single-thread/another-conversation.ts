import { isSingleThreadMode } from '@/store/single-thread'

/**
 * hc-1014: ⌘T (a new session tab) and the new-window shortcut would each start
 * a second conversation. In single-thread product mode they open the one
 * thread instead (`openThread`: the fresh-draft path, which the shell turns
 * into the thread); otherwise they do what they always did.
 */
export function openAnotherConversation(open: () => void, openThread: () => void): void {
  if (isSingleThreadMode()) {
    openThread()
  } else {
    open()
  }
}
