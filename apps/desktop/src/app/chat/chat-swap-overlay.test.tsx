// The overlay used to run its own 80ms setInterval + setState braille ticker —
// the same mechanism class (per-tick DOM mutation scheduling a style recalc)
// that GlyphSpinner was rewritten to remove. It now renders GlyphSpinner, so
// what needs pinning is that no timer comes back, that the label still survives
// the fade-out, and that the spinner stops animating once the swap is done.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setMultiBotFlagForTest } from '@/store/single-thread-bots'

import { ChatSwapOverlay, SWAP_OVERLAY_DELAY } from './chat-swap-overlay'

afterEach(() => {
  cleanup()
})

describe('ChatSwapOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('animates the glyph without any timer', () => {
    const { container } = render(<ChatSwapOverlay profile="turqoise" />)

    expect(container.querySelector('.glyph-spinner__strip')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(5_000)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('names the waking profile', () => {
    render(<ChatSwapOverlay profile="turqoise" />)

    expect(screen.getByText(/turqoise/)).toBeTruthy()
  })

  it('keeps the last profile name through the fade-out, with the glyph frozen', () => {
    const { container, rerender } = render(<ChatSwapOverlay profile="turqoise" />)

    expect(container.querySelector('.glyph-spinner')?.hasAttribute('data-paused')).toBe(false)

    rerender(<ChatSwapOverlay profile={null} />)

    // Label held so the overlay doesn't blank while it fades.
    expect(screen.getByText(/turqoise/)).toBeTruthy()
    // ...and the spinner stops, the way clearing the interval used to stop it.
    expect(container.querySelector('.glyph-spinner')?.getAttribute('data-paused')).toBe('true')
  })
})

describe('hc-1146 the overlay between assistants', () => {
  afterEach(() => {
    setMultiBotFlagForTest(false)
    setSingleThreadFlagForTest(false)
  })

  const overlay = (container: HTMLElement) => container.firstElementChild as HTMLElement

  it('fades in only after SWAP_OVERLAY_DELAY with several assistants (CSS, no timer), and fades out at once', () => {
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    const { container, rerender } = render(<ChatSwapOverlay profile="writer" />)

    expect(SWAP_OVERLAY_DELAY).toBe('delay-400')
    expect(overlay(container).className.split(' ')).toEqual(expect.arrayContaining(['opacity-100', 'delay-400']))

    rerender(<ChatSwapOverlay profile={null} />)

    expect(overlay(container).className).not.toContain('delay-')
  })

  it.each([
    ['both switches off', false],
    ['single-thread alone', true]
  ])('shows at once with %s, as it always did', (_label, singleThread) => {
    setSingleThreadFlagForTest(singleThread)
    const { container } = render(<ChatSwapOverlay profile="writer" />)

    expect(overlay(container).className).toBe(
      'pointer-events-none absolute inset-0 z-50 flex items-center justify-center transition-opacity duration-150 ease-out opacity-100'
    )
  })
})
