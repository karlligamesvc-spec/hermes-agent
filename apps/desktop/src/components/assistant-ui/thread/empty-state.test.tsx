import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import { Thread } from '.'

// hc-554 put a shelf under the greeting, which makes the zero state tall enough
// to overflow a short window (or any window once the shelf grows). hc-794 keeps
// the same layout contract while making the real business shelf the default.
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
  it('shows the greeting and the real business start shelf', () => {
    renderEmptyThread()

    expect(screen.getByRole('heading', { name: '今天想推进什么业务？' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /从市场机会到上架素材/ })).toBeTruthy()
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

    // …and something has to actually scroll once it outgrows the row.
    expect(
      scroller?.className,
      'the zero state lost its own scroll container — overflow is clipped, not scrollable'
    ).toContain('overflow-y-auto')

    // Kael, hc-590 review: the zero state scrolls but never SHOWS a bar — it
    // should read as a calm landing surface, not a scrolling document. All
    // three engines' hiding idioms must stay (drop one and that platform's
    // bar reappears silently).
    expect(
      scroller?.className,
      'the zero-state scrollbar became visible again — keep all three hiding idioms'
    ).toContain('[scrollbar-width:none]')
    expect(scroller?.className).toContain('[&::-webkit-scrollbar]:hidden')
    expect(scroller?.className).toContain('[-ms-overflow-style:none]')
  })

  // Kael, hc-590 review: the block did not read as centred. It was centred —
  // on the scroller, whose bottom slice is hidden under the floating composer.
  // Centring has to happen inside the band the user can actually see.
  //
  // Measured on a real engine (three window sizes, harness in the hc-590 PR
  // notes): the block's centre sat 8.5px above the visible band's centre before
  // and 11.5px after — but on a window too short for the shelf the dead space
  // above the greeting went from 119px to 57px, which is the case Kael was
  // looking at.
  it('centres on the visible band, not on the scroller', () => {
    const { container } = renderEmptyThread()

    const centeringBox = container.querySelector('[data-slot="aui_intro"]')?.parentElement
    const padding = centeringBox?.className.match(/\bp[btye]?-\[[^\]]*\]/gu) ?? []

    // Exactly one padding utility, on the one covered edge, and every term in
    // it is a measured variable — never a hard-coded height. `--composer-
    // surface-measured-height` and not `--composer-measured-height`: the
    // viewport already stops above the composer's outer padding, so only the
    // surface actually covers it.
    expect(padding).toHaveLength(1)

    const allowance = padding[0] ?? ''

    expect(allowance).toMatch(/^pb-\[/u)
    expect(allowance, 'the bottom allowance stopped tracking the measured composer surface').toContain(
      'var(--composer-surface-measured-height)'
    )
    expect(
      allowance.replace(/var\(--[a-z-]+\)/gu, ''),
      'the allowance grew a hard-coded length — it has to follow the measured composer'
    ).not.toMatch(/\d/u)

    // Padding the top as well re-centres on the raw box and, on a short window,
    // becomes dead space above the greeting. Nothing covers the top of this
    // surface — what can sit above it is a flow sibling, not an overlay.
    expect(
      centeringBox?.className,
      'a top allowance is back — the block will sit low again (nothing overlaps the top here)'
    ).not.toMatch(/\b(pt|py)-\[/u)
  })

  // The clearance is a wrapper concern now. Upstream also carries it on the
  // intro element itself, and with both in play the block is pushed off centre
  // by half a composer in the other direction — the bug this pair replaced.
  it('counts the composer clearance exactly once', () => {
    const styles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf-8')
    const introRule = /\[data-slot='aui_intro'\]\s*\{[^}]*\}/u.exec(styles)?.[0]

    expect(
      introRule,
      "the [data-slot='aui_intro'] rule vanished — re-check where the intro gets its layout"
    ).toBeTruthy()
    expect(
      introRule,
      'the intro carries composer clearance again; the zero-state wrapper already adds it, and two of them break the centring'
    ).not.toContain('--composer-measured-height')
  })
})
