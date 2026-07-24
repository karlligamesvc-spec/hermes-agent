/**
 * hc-447 更新日志 (changelog) store — renderer-side mirror of the hc-446
 * announcement feed, fetched through the main-process bridge (the stored
 * login JWT never crosses to the renderer; see electron/apex-announcements.cjs).
 *
 * One atom holding a small state union rather than separate loading/error/data
 * atoms — the changelog panel only ever renders one of these states at a time,
 * so a union keeps "loading AND stale error" impossible by construction.
 *
 * loadAnnouncements() is meant to be called when the changelog panel opens
 * (opt-in, like the engine update check) — not on every settings mount. It is
 * idempotent against overlapping calls (a second call while one is in flight
 * reuses the first's promise) so a fast re-open doesn't fire a duplicate fetch.
 */

import { atom } from 'nanostores'

import type { DesktopAnnouncementItem } from '@/global'

export type AnnouncementsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; needsSignIn: boolean }
  | { status: 'loaded'; items: readonly DesktopAnnouncementItem[] }

export const $announcements = atom<AnnouncementsState>({ status: 'idle' })

let inflight: Promise<void> | null = null

/** Reset to idle — called when the changelog dialog closes, so the NEXT open
 *  re-fetches instead of flashing stale content from a prior session. */
export function resetAnnouncements(): void {
  inflight = null
  $announcements.set({ status: 'idle' })
}

export function loadAnnouncements(): Promise<void> {
  if (inflight) {
    return inflight
  }

  const bridge = window.hermesDesktop?.announcements

  if (!bridge) {
    // Older main process with no bridge yet — same soft-unavailable copy as
    // any other fetch failure; the panel never hard-errors over a version skew.
    $announcements.set({ status: 'error', needsSignIn: false })

    return Promise.resolve()
  }

  $announcements.set({ status: 'loading' })

  inflight = (async () => {
    try {
      const result = await bridge.list()

      if (!result.ok) {
        $announcements.set({ status: 'error', needsSignIn: Boolean(result.needsSignIn) })

        return
      }

      $announcements.set({ status: 'loaded', items: result.items })

      // Best-effort read receipts for whatever just rendered — fire-and-forget,
      // never gates the list (markAnnouncementRead's IPC handler never throws).
      for (const item of result.items) {
        if (!item.read) {
          void bridge.markRead(item.id)
        }
      }
    } catch {
      $announcements.set({ status: 'error', needsSignIn: false })
    } finally {
      inflight = null
    }
  })()

  return inflight
}
