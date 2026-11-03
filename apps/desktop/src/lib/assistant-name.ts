/**
 * hc-1077: the assistant's name in copy that says 「APEX」 about it. A leaf, so
 * the quick-entry window (no stores, no gateway) can use it too; the
 * several-assistants store re-exports it (store/single-thread-bots.ts).
 */

/** APEX's name until it is given another (K6: it can be renamed). The same in every locale. */
export const APEX_NAME = 'APEX'

/**
 * `text` with the assistant's name where it says APEX: unchanged when `name`
 * is null (one assistant) or APEX's own. Only for copy whose every 「APEX」 is
 * the assistant speaking or being spoken to — never the app's name.
 */
export function withBotName(text: string, name: null | string | undefined): string {
  return !name || name === APEX_NAME ? text : text.split(APEX_NAME).join(name)
}
