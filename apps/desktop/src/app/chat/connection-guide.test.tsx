// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionGuide } from './connection-guide'

type ImChannel = { channelId: string }

// Drive the shared useChannelStatus off stubbed local bridges (imEntry.list for
// the IM legs, daemon.status for phone-remote) — no network, same as prod.
function setBridges(imChannels: ImChannel[] | undefined, daemonStatus = 'offline') {
  const hermesDesktop: Record<string, unknown> = {}

  if (imChannels !== undefined) {
    hermesDesktop.imEntry = { list: () => Promise.resolve({ channels: imChannels }) }
  }

  hermesDesktop.daemon = {
    onStatus: vi.fn(() => () => undefined),
    status: () => Promise.resolve({ status: daemonStatus })
  }
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = hermesDesktop
}

function renderGuide(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('ConnectionGuide', () => {
  it('renders nothing when no channel bridge is available (web / older main)', () => {
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {}
    const { container } = renderGuide(<ConnectionGuide />)
    expect(container.firstChild).toBeNull()
  })

  it('guides every connectable channel when the user has connected none', async () => {
    setBridges([], 'offline')
    renderGuide(<ConnectionGuide />)
    // feishu + weixin (imEntry) + phone-remote (daemon) — three connect CTAs.
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
  })

  it('self-gates to nothing once any channel is connected', async () => {
    setBridges([{ channelId: 'feishu' }], 'offline')
    const { container } = renderGuide(<ConnectionGuide />)
    // Let the async bridge reads resolve, then confirm it stays hidden.
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
