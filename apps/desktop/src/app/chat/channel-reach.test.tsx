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
// "Bind a channel" remains reachable without passive channel chrome.
//
// hc-590 took the first-run ConnectionGuide banner out of the chat's main
// content (Kael's call — it squatted on every unconnected user's screen, in the
// live conversation as much as the zero state). The sidebar status rows and
// phone-remote strip were later removed for the same reason. The active paths
// remain explicit user actions:
//
//   1. "连接助手" in the account menu;
//   2. the zero state's "连接你的分身" strip, under the scenario cards.
//
// Source guards keep both destinations reachable and prevent any passive
// channel banner/status block from creeping back into the app chrome.

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
  it('the zero-state connect strip offers a way in while nothing is bound', async () => {
    setUnboundBridges()
    renderZh(<ScenarioShelf />)

    expect(await screen.findByText('连接你的分身')).toBeTruthy()

    await waitFor(() => expect(screen.getAllByRole('button', { name: /扫码绑定/u }).length).toBeGreaterThan(0))
  })

  it('keeps passive channel status out of the chat and sidebar chrome', () => {
    const chatView = readFileSync(resolve(__dirname, 'index.tsx'), 'utf-8')
    const sidebar = readFileSync(resolve(__dirname, 'sidebar', 'index.tsx'), 'utf-8')
    const accountPanel = readFileSync(resolve(__dirname, 'sidebar', 'account-panel.tsx'), 'utf-8')

    expect(chatView).not.toMatch(/ConnectionGuide|connection-guide|DirectConnectBanner/u)
    expect(sidebar).not.toContain('SidebarChannelStatus')
    expect(accountPanel).toContain('<span>{nav.assistant}</span>')
  })
})
