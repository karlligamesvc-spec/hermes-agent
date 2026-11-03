/**
 * hc-1101: the sends the gateway has not taken yet.
 *
 * The prompt submit holds one lock per session (use-prompt-actions/utils.ts,
 * `acquireSubmitInFlight`): it is taken before the send and released once
 * `prompt.submit` comes back, fails or expires. This publishes those holds
 * (session key → when the hold was taken), so the thread can show
 * 「仍在发送中」 under a send that has been waiting a while
 * (thread/user-message-sending.tsx).
 */

import { atom } from 'nanostores'

/** Submit-lock keys (stored or runtime session id, or `__pending_new__`) → epoch ms the hold was taken. */
export const $submitsInFlight = atom<ReadonlyMap<string, number>>(new Map())

export function publishSubmitsInFlight(holds: ReadonlyMap<string, number>): void {
  $submitsInFlight.set(new Map(holds))
}
