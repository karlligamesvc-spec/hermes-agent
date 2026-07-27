import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import { Thread } from '.'

// hc-554 put the scenario shelf under the greeting, which makes the zero state
// tall enough to overflow a short window (or any window once the shelf grows).
// Upstream's thread/ centers the placeholder with a clamped flex box, and a
// clamped centered box clips its own top: the greeting slides off above the
// viewport with no way to scroll back to it. Ours gives the placeholder its own
// scroller and lets the centering box grow past it — centered when it fits,
// scrollable when it doesn't.
//
// jsdom does no layout, so the contract is asserted where it is expressed: the
// class names on the two elements wrapping the intro. That is also exactly what
// a re-sync with upstream would overwrite.

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

function EmptyThread() {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [],
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread intro={{}} />
    </AssistantRuntimeProvider>
  )
}

function renderEmptyThread() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <EmptyThread />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(cleanup)

describe('thread zero state', () => {
  it('shows the greeting and the hc-554 scenario shelf', () => {
    renderEmptyThread()

    expect(screen.getByRole('heading', { name: '我们该做什么？' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /热榜/ })).toBeTruthy()
  })

  it('keeps the top of an over-tall zero state reachable', () => {
    const { container } = renderEmptyThread()

    const intro = container.querySelector('[data-slot="aui_intro"]')

    expect(intro).not.toBeNull()

    const centeringBox = intro?.parentElement
    const scroller = centeringBox?.parentElement

    // Grows with its content instead of being clamped to the row height — this
    // is what stops a taller-than-viewport shelf from clipping the greeting.
    expect(centeringBox?.className).toContain('min-h-full')
    expect(
      centeringBox?.className,
      'the centering box is clamped again (min-h-0) — a tall zero state will clip its own top'
    ).not.toContain('min-h-0')
    expect(centeringBox?.className).toContain('justify-center')

    // Symmetric composer-height padding: the floating composer overlaps both
    // ends, so `pt-` alone leaves the last shelf row unreachable.
    expect(centeringBox?.className).toContain('py-[var(--composer-measured-height)]')
    expect(centeringBox?.className).not.toContain('pt-[var(--composer-measured-height)]')

    // …and something has to actually scroll once it outgrows the row.
    expect(
      scroller?.className,
      'the zero state lost its own scroll container — overflow is clipped, not scrollable'
    ).toContain('overflow-y-auto')
  })
})
