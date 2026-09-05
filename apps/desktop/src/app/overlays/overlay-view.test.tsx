// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OverlayView } from './overlay-view'

afterEach(cleanup)

describe('OverlayView responsive product surfaces', () => {
  it('makes opted-in surfaces truly full-screen through the 760px breakpoint', () => {
    render(
      <OverlayView compactFullscreen onClose={vi.fn()}>
        <p>content</p>
      </OverlayView>
    )

    const overlay = screen.getByText('content').closest('[data-overlay-surface]')
    const card = screen.getByText('content').parentElement?.parentElement

    expect(overlay?.getAttribute('data-responsive-mode')).toBe('compact-fullscreen')
    expect(overlay?.className).toContain('max-[47.5rem]:p-0')
    expect(overlay?.className).toContain('max-[47.5rem]:backdrop-blur-none')
    expect(card?.className).toContain('max-[47.5rem]:rounded-none')
    expect(card?.className).toContain('max-[47.5rem]:border-0')
    expect(card?.className).toContain('max-[47.5rem]:shadow-none')
  })

  it('preserves the wide inset dialog treatment and the default behavior of other overlays', () => {
    render(
      <OverlayView onClose={vi.fn()}>
        <p>default content</p>
      </OverlayView>
    )

    const overlay = screen.getByText('default content').closest('[data-overlay-surface]')
    const card = screen.getByText('default content').parentElement?.parentElement

    expect(overlay?.getAttribute('data-responsive-mode')).toBe('inset')
    expect(overlay?.className).toContain('sm:p-[calc(var(--titlebar-height)+0.875rem)]')
    expect(overlay?.className).not.toContain('max-[47.5rem]:p-0')
    expect(card?.className).toContain('rounded-xl')
  })
})
