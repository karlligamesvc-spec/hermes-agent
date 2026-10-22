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

/** Keybind actions that start a second conversation. */
const NEW_CONVERSATION_ACTIONS = new Set(['session.new', 'session.newTab', 'session.newWindow'])

/** The command palette's groups without its 新建会话 / new-window rows in single-thread product mode. */
export function withoutNewConversationItems<G extends { items: readonly { action?: string }[] }>(groups: G[]): G[] {
  if (!isSingleThreadMode()) {
    return groups
  }

  return groups
    .map(group => ({ ...group, items: group.items.filter(item => !NEW_CONVERSATION_ACTIONS.has(item.action ?? '')) }))
    .filter(group => group.items.length > 0)
}
