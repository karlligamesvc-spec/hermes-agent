import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopImEntryBinding, DesktopImEntryListResult } from '@/global'

import { imEntrySummaryCopy } from './im-entry-settings'

// hc-417 收口 "IM 入口" settings-card. The card talks only to
// window.hermesDesktop.imEntry (the main-process bridge, same one the full
// /im-entry page uses) — no @/hermes HTTP. We stub the bridge per test to
// drive the loading / empty / bound-count states, and assert the button
// actually navigates to the full page (the whole point of this card).

const list = vi.fn<() => Promise<DesktopImEntryListResult>>()

function stubBridge() {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    imEntry: { list }
  }
}

function binding(channelId: string): DesktopImEntryBinding {
  return { boundAt: Date.now(), channelId, domain: '' }
}

beforeEach(() => {
  stubBridge()
  list.mockResolvedValue({ channels: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

async function renderCard() {
  const { ImEntrySettings } = await import('./im-entry-settings')

  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route element={<ImEntrySettings />} path="/settings" />
        <Route element={<div>im-entry-page-marker</div>} path="/im-entry" />
      </Routes>
    </MemoryRouter>
  )
}

describe('imEntrySummaryCopy (pure mapping)', () => {
  const copy = {
    boundEmpty: 'No channels connected yet.',
    loading: 'Loading channels…',
    settingsCard: {
      boundSummary: (count: number) => `${count} ${count === 1 ? 'channel' : 'channels'} connected`
    }
  }

  it.each([
    [null, 'Loading channels…'],
    [[], 'No channels connected yet.'],
    [[binding('feishu')], '1 channel connected'],
    [[binding('feishu'), binding('dingtalk')], '2 channels connected']
  ] as const)('bound=%o -> %s', (bound, expected) => {
    expect(imEntrySummaryCopy(bound as DesktopImEntryBinding[] | null, copy)).toBe(expected)
  })
})

describe('ImEntrySettings', () => {
  it('renders nothing when the desktop bridge is absent (web build)', async () => {
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    const { container } = await renderCard()
    expect(container.firstChild).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('shows the empty-state summary when no channel is bound', async () => {
    list.mockResolvedValue({ channels: [] })
    await renderCard()

    expect(await screen.findByText('No channels connected yet.')).toBeTruthy()
  })

  it('shows the bound-count summary when channels are bound', async () => {
    list.mockResolvedValue({ channels: [binding('feishu')] })
    await renderCard()

    expect(await screen.findByText('1 channel connected')).toBeTruthy()
  })

  it('navigates to the full IM 入口 page on click', async () => {
    list.mockResolvedValue({ channels: [] })
    await renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Go to messaging' }))

    expect(await screen.findByText('im-entry-page-marker')).toBeTruthy()
  })
})
