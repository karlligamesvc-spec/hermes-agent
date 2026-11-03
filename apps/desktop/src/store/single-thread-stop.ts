/**
 * hc-1060 (N5): how the activity line's 「停」 stops the thread's running turn.
 *
 * In single-thread mode the Stop button left the composer for the activity
 * line, which sits inside the transcript and has no handle on the chat's
 * cancel. The main composer (app/single-thread/composer-gate.tsx) publishes its
 * halt here — the same one the composer's Stop used: park the queue, then
 * interrupt — and takes it back when it unmounts or the mode turns off. No
 * handler, no 「停」.
 */

import { atom } from 'nanostores'

export const $threadStop = atom<null | (() => void)>(null)

/** Publish `stop` as the thread's halt. Returns the disposer that withdraws it. */
export function publishThreadStop(stop: () => void): () => void {
  $threadStop.set(stop)

  return () => {
    if ($threadStop.get() === stop) {
      $threadStop.set(null)
    }
  }
}
