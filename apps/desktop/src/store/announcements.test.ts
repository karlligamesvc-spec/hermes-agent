// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopAnnouncementItem, DesktopAnnouncementsListResult } from '@/global'

import { $announcements, loadAnnouncements, resetAnnouncements } from './announcements'

// hc-447 更新日志 store. Talks only to window.hermesDesktop.announcements (the
// main-process bridge) — no @/hermes HTTP, no direct fetch. Same stubbing
// convention as feishu-settings.test.tsx: stub the bridge per test, drive the
// three outcomes (loaded / needs-sign-in / fetch failure) plus the read-receipt
// fan-out and the in-flight de-dupe.

const list = vi.fn<() => Promise<DesktopAnnouncementsListResult>>()
const markRead = vi.fn<(id: string) => Promise<{ ok: boolean }>>()

function stubBridge() {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    announcements: { list, markRead }
  }
}

function item(patch: Partial<DesktopAnnouncementItem> = {}): DesktopAnnouncementItem {
  return {
    id: 'ann-1',
    title: 'You can now see the changelog',
    body: 'Open About → Changelog to see recent product updates.',
    level: 'normal',
    publishedAt: '2026-07-20T00:00:00Z',
    read: false,
    ...patch
  }
}

beforeEach(() => {
  // The atom + in-flight guard are module-level state shared across tests in
  // this file — reset explicitly rather than relying on every test happening
  // to leave them clean, so test order/insertion can never leak state.
  resetAnnouncements()
  stubBridge()
  markRead.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('loadAnnouncements', () => {
  it('goes loading -> loaded with the fetched items on success', async () => {
    list.mockResolvedValue({ ok: true, items: [item()] })

    const pending = loadAnnouncements()
    expect($announcements.get()).toEqual({ status: 'loading' })

    await pending
    expect($announcements.get()).toEqual({ status: 'loaded', items: [item()] })
  })

  it('reports an empty feed as loaded with zero items, not an error', async () => {
    list.mockResolvedValue({ ok: true, items: [] })

    await loadAnnouncements()

    expect($announcements.get()).toEqual({ status: 'loaded', items: [] })
  })

  it('surfaces needsSignIn from an ok:false result', async () => {
    list.mockResolvedValue({ ok: false, items: [], needsSignIn: true, message: 'NOT_SIGNED_IN' })

    await loadAnnouncements()

    expect($announcements.get()).toEqual({ status: 'error', needsSignIn: true })
  })

  it('reports a plain fetch failure as error with needsSignIn:false', async () => {
    list.mockResolvedValue({ ok: false, items: [], message: 'FETCH_FAILED' })

    await loadAnnouncements()

    expect($announcements.get()).toEqual({ status: 'error', needsSignIn: false })
  })

  it('treats a rejected bridge call the same as a soft fetch failure', async () => {
    list.mockRejectedValue(new Error('IPC channel closed'))

    await loadAnnouncements()

    expect($announcements.get()).toEqual({ status: 'error', needsSignIn: false })
  })

  it('degrades to a soft error when the bridge is entirely absent (older main process)', async () => {
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop

    await loadAnnouncements()

    expect($announcements.get()).toEqual({ status: 'error', needsSignIn: false })
    expect(list).not.toHaveBeenCalled()
  })

  it('fires a best-effort read receipt for every unread item and none for already-read ones', async () => {
    list.mockResolvedValue({
      ok: true,
      items: [item({ id: 'unread-1', read: false }), item({ id: 'already-read', read: true }), item({ id: 'unread-2', read: false })]
    })

    await loadAnnouncements()

    expect(markRead).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenCalledWith('unread-1')
    expect(markRead).toHaveBeenCalledWith('unread-2')
    expect(markRead).not.toHaveBeenCalledWith('already-read')
  })

  it('does not let a rejected markRead reject the loadAnnouncements call itself', async () => {
    list.mockResolvedValue({ ok: true, items: [item({ read: false })] })
    markRead.mockRejectedValue(new Error('should never surface'))

    await expect(loadAnnouncements()).resolves.toBeUndefined()
    expect($announcements.get().status).toBe('loaded')
  })

  it('de-dupes overlapping calls: a second call while one is in flight reuses the same fetch', async () => {
    let resolveList: (value: DesktopAnnouncementsListResult) => void = () => {}
    list.mockReturnValue(
      new Promise(resolve => {
        resolveList = resolve
      })
    )

    const first = loadAnnouncements()
    const second = loadAnnouncements()

    resolveList({ ok: true, items: [] })
    await Promise.all([first, second])

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('fetches again on a fresh call once the previous one has settled', async () => {
    list.mockResolvedValue({ ok: true, items: [] })

    await loadAnnouncements()
    await loadAnnouncements()

    expect(list).toHaveBeenCalledTimes(2)
  })
})

describe('resetAnnouncements', () => {
  it('returns to idle so the next open re-fetches instead of showing stale content', async () => {
    list.mockResolvedValue({ ok: true, items: [item()] })
    await loadAnnouncements()
    expect($announcements.get().status).toBe('loaded')

    resetAnnouncements()

    expect($announcements.get()).toEqual({ status: 'idle' })
  })
})
