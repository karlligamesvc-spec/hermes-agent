// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import { ScenarioShelf } from './scenarios/scenario-shelf'
import { SidebarChannelStatus } from './sidebar/channel-status'

// "Bind a channel" must stay reachable from at least TWO places.
//
// hc-590 took the first-run ConnectionGuide banner out of the chat's main
// content (Kael's call — it squatted on every unconnected user's screen, in the
// live conversation as much as the zero state). That was the loudest of three
// entry points, and losing it is only safe because the other two are permanent:
//
//   1. the sidebar's "渠道 · 分身在哪" block — always there, bound or not;
//   2. the zero state's "连接你的分身" strip, under the scenario cards.
//
// Each is small, easy to mistake for decoration, and easy to delete while
// tidying. Delete both and a first-run user has no way to connect anything and
// nothing anywhere fails. So: one test per path, plus a guard that the banner
// does not creep back into the main content.

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)

/** Bridges present, nothing bound — the first-run user this is all for. */
function setUnboundBridges() {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    imEntry: { list: () => Promise.resolve({ channels: [] }) },
    daemon: {
      onStatus: vi.fn(() => () => undefined),
      status: () => Promise.resolve({ enabled: false, status: 'offline' })
    }
  }
}

function renderZh(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          {node}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('reaching channel binding', () => {
  it('path 1: the sidebar block offers a way in while nothing is bound', async () => {
    setUnboundBridges()
    renderZh(<SidebarChannelStatus />)

    // Feishu / WeChat go to the binding flow; phone-remote to its setting.
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
    expect(screen.getByText('渠道 · 分身在哪')).toBeTruthy()
    expect(screen.getAllByText('扫码绑定').length).toBeGreaterThan(0)
  })

  it('path 2: the zero-state connect strip offers a way in while nothing is bound', async () => {
    setUnboundBridges()
    renderZh(<ScenarioShelf />)

    expect(await screen.findByText('连接你的分身')).toBeTruthy()

    await waitFor(() => expect(screen.getAllByRole('button', { name: /扫码绑定/u }).length).toBeGreaterThan(0))
  })

  it('keeps the connect banner out of the chat surface', () => {
    // Source-contract, because the regression is a re-add: the banner rendered
    // fine, it just took a row of everyone's main content forever. A behavioral
    // test would have to mount the whole chat view to notice.
    const chatView = readFileSync(resolve(__dirname, 'index.tsx'), 'utf-8')

    expect(
      chatView,
      'a connect-guidance banner is back in the chat surface — it belongs in the sidebar block and the zero-state strip'
    ).not.toMatch(/ConnectionGuide|connection-guide/u)
  })
})
