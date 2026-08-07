// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SidebarChannelStatus } from './channel-status'

type ImChannel = { channelId: string }

// Bridge stubbing mirrors the zero-state connect strip's suite — the two
// surfaces are the two ways to reach channel binding, so they read the same
// useChannelStatus and must agree.
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

function renderStatus(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('SidebarChannelStatus', () => {
  it('renders nothing when no channel bridge is available (web / older main)', () => {
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {}
    const { container } = renderStatus(<SidebarChannelStatus />)
    expect(container.firstChild).toBeNull()
  })

  it('stays hidden before the IM bridge answers, so it never flashes at boot', () => {
    // No imEntry bridge wired up yet (undefined) and the daemon promise still
    // pending — synchronous first render, before any awaits resolve.
    setBridges(undefined, 'offline')
    const { container } = renderStatus(<SidebarChannelStatus />)
    expect(container.firstChild).toBeNull()
  })

  it('state ①: stays put with nothing bound, so a first-run user has a way in', async () => {
    // It used to suppress itself here, deferring to the ConnectionGuide banner
    // at the top of the chat. hc-590 removed that banner from the main content,
    // so hiding now would strand a first-run user: this block and the zero
    // state's connect strip are the only two ways to reach binding.
    setBridges([], 'offline')
    renderStatus(<SidebarChannelStatus />)

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))

    for (const row of screen.getAllByRole('button')) {
      expect(row.querySelector('[aria-hidden="true"]')?.className).toContain('bg-muted-foreground')
    }
  })

  it('state ②: shows the real connection status once any channel is bound', async () => {
    setBridges([{ channelId: 'feishu' }], 'offline')
    renderStatus(<SidebarChannelStatus />)
    // feishu bound → guideVisible false → this block renders; three rows
    // (feishu/weixin/phone-remote) in that fixed order. Assert on the status
    // dot's tone class rather than display text — display strings are locale-
    // dependent (this suite's jsdom env resolves the English catalog), while
    // the bound/unbound tone split is the actual behavior under test.
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
    const [feishuRow, weixinRow] = screen.getAllByRole('button')
    expect(feishuRow.querySelector('[aria-hidden="true"]')?.className).toContain('bg-primary')
    expect(weixinRow.querySelector('[aria-hidden="true"]')?.className).toContain('bg-muted-foreground')
  })
})
