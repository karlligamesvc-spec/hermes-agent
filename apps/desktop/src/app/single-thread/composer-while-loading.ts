/**
 * hc-1146 切换助手不闪屏: with several assistants on, the composer stays on
 * screen while a conversation's history loads (an assistant just switched
 * to) instead of disappearing until the transcript arrives and coming back —
 * a large part of what a switch used to flash. It is not `disabled`: that
 * would swap its placeholder for 「正在启动 APEX…」 under another assistant's
 * name. A send waits instead: the single-thread middleware keeps it in the
 * composer with 「正在打开对话」 until the conversation is bound
 * (composer-middleware.ts).
 *
 * Read during the chat view's render: it re-renders as a load starts and
 * ends. Off (one assistant, developer mode) the composer hides as it always did.
 */

import { isMultiBotMode } from '@/store/single-thread-bots'

/** Whether the chat view hides its composer while `loading` a conversation's history. */
export function composerHiddenWhileLoading(loading: boolean): boolean {
  return loading && !isMultiBotMode()
}

/**
 * hc-1146: whether the chat view's composer refuses sends while the gateway is
 * not open (the main engine starting, a reconnect). Off (one assistant,
 * developer mode) it does, as it always did: Enter does nothing until the
 * gateway is back. With several assistants on it does not — a send made then
 * waits above the composer and goes out once the gateway and the thread are
 * there (composer-middleware.ts `connecting`, held-send-release.ts).
 */
export function composerDisabledWhileConnecting(gatewayOpen: boolean): boolean {
  return !gatewayOpen && !isMultiBotMode()
}
