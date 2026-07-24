// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnnouncementsState } from '@/store/announcements'

// hc-447 更新日志 entry point (Settings → About). Same stubbing convention as
// shell-update-pill.test.tsx: a real atom + stubbed actions, so the
// useStore-driven re-render is production-accurate and only the store's
// IPC-backed actions are replaced. Mutating the atom from outside a React
// event handler needs `act()` (same as runtime-update-pill.test.tsx) so the
// resulting re-render is flushed before the assertion runs.

const loadAnnouncementsMock = vi.fn<() => Promise<void>>()
const resetAnnouncementsMock = vi.fn<() => void>()

vi.mock('@/store/announcements', async () => {
  const { atom } = await import('nanostores')

  return {
    $announcements: atom<AnnouncementsState>({ status: 'idle' }),
    loadAnnouncements: () => loadAnnouncementsMock(),
    resetAnnouncements: () => resetAnnouncementsMock()
  }
})

import { $announcements } from '@/store/announcements'

import { ChangelogSection } from './changelog-section'

beforeEach(() => {
  loadAnnouncementsMock.mockReset()
  resetAnnouncementsMock.mockReset()
  $announcements.set({ status: 'idle' })
})

afterEach(() => {
  cleanup()
})

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'View' }))
}

function setAnnouncements(next: AnnouncementsState) {
  act(() => {
    $announcements.set(next)
  })
}

describe('ChangelogSection', () => {
  it('always renders the entry row (title, intro, View button) regardless of fetch state', () => {
    render(<ChangelogSection />)

    expect(screen.getByText('Changelog')).toBeTruthy()
    expect(screen.getByText("See what's new in APEX.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View' })).toBeTruthy()
    // The dialog itself hasn't been opened yet — no fetch fired on mount.
    expect(loadAnnouncementsMock).not.toHaveBeenCalled()
  })

  it('fetches on open and shows a loading state before the store resolves', () => {
    render(<ChangelogSection />)

    openDialog()

    expect(loadAnnouncementsMock).toHaveBeenCalledTimes(1)
    // PageLoader carries the label as aria-label on the status region, not as
    // visible text — assert via role/name rather than getByText.
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeTruthy()
  })

  it('shows the empty-state copy for a genuinely empty feed (not an error)', () => {
    render(<ChangelogSection />)
    openDialog()

    setAnnouncements({ status: 'loaded', items: [] })

    expect(screen.getByText('No announcements yet — check back soon.')).toBeTruthy()
  })

  it('shows a sign-in prompt when the store reports needsSignIn', () => {
    render(<ChangelogSection />)
    openDialog()

    setAnnouncements({ status: 'error', needsSignIn: true })

    expect(screen.getByText('Sign in to your ApexNodes account to see product updates.')).toBeTruthy()
  })

  it('shows a soft load-error message for a plain fetch failure', () => {
    render(<ChangelogSection />)
    openDialog()

    setAnnouncements({ status: 'error', needsSignIn: false })

    expect(screen.getByText("Couldn't load the changelog. Check your connection and try again.")).toBeTruthy()
  })

  it('renders each announcement title and body when the feed has content', () => {
    render(<ChangelogSection />)
    openDialog()

    setAnnouncements({
      status: 'loaded',
      items: [
        {
          id: 'ann-1',
          title: 'You can now see the changelog',
          body: 'Open About → Changelog to see recent product updates.',
          level: 'normal',
          publishedAt: '2026-07-20T00:00:00Z',
          read: false
        }
      ]
    })

    expect(screen.getByText('You can now see the changelog')).toBeTruthy()
    expect(screen.getByText('Open About → Changelog to see recent product updates.')).toBeTruthy()
  })

  it('resets the store when the dialog closes, so the next open re-fetches', () => {
    render(<ChangelogSection />)
    openDialog()
    setAnnouncements({ status: 'loaded', items: [] })

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })

    expect(resetAnnouncementsMock).toHaveBeenCalledTimes(1)
  })
})
