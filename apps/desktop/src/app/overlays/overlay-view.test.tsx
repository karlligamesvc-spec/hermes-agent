// @vitest-environment jsdom
import { readFileSync } from 'node:fs'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { stubMenuDomApis } from '@/test/jsdom'

import { OverlayView } from './overlay-view'

beforeAll(stubMenuDomApis)

const stylesSource = readFileSync('src/styles.css', 'utf8')

afterEach(() => {
  cleanup()
  globalThis.document.body.style.overflow = ''
})

function OverlayHarness() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open profile
      </button>
      {open ? (
        <OverlayView onClose={() => setOpen(false)} title="Profile dialog">
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </OverlayView>
      ) : null}
    </>
  )
}

describe('OverlayView responsive product surfaces', () => {
  it('defines the complete overlay z-index ladder used by shared primitives', () => {
    const tokens = [
      'modal-backdrop',
      'modal',
      'modal-popover',
      'over-modal',
      'over-modal-content',
      'switcher-backdrop',
      'switcher',
      'connecting',
      'onboarding',
      'onboarding-popover',
      'setup',
      'crash'
    ]

    for (const token of tokens) {
      expect(stylesSource).toMatch(new RegExp(`--z-${token}:\\s*\\d+;`))
    }
  })

  it('keeps an open select inside the overlay focus scope without clipping it', () => {
    render(
      <OverlayView onClose={vi.fn()} title="Security settings">
        <Select defaultOpen defaultValue="smart">
          <SelectTrigger aria-label="Approval mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="smart">Smart</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
      </OverlayView>
    )

    const dialog = screen.getByRole('dialog', { name: 'Security settings' })
    const option = screen.getByRole('option', { name: 'Manual' })
    const clipBox = dialog.querySelector('[data-overlay-clip]')

    expect(dialog.contains(option)).toBe(true)
    expect(clipBox?.contains(option)).toBe(false)
    expect(dialog.className).not.toContain('overflow-hidden')
    expect(clipBox?.className).toContain('overflow-hidden')
  })

  it('makes opted-in surfaces truly full-screen in a 752px native window at product zoom', () => {
    render(
      <OverlayView compactFullscreen onClose={vi.fn()} title="Compact dialog">
        <p>content</p>
      </OverlayView>
    )

    const card = screen.getByRole('dialog', { name: 'Compact dialog' })
    const overlay = card.closest('[data-responsive-mode]')

    expect(overlay?.getAttribute('data-responsive-mode')).toBe('compact-fullscreen')
    expect(overlay?.className).toContain('max-[53rem]:!p-0')
    expect(globalThis.document.querySelector('[data-overlay-backdrop]')?.className).toContain(
      'max-[53rem]:backdrop-blur-none'
    )
    expect(card?.className).toContain('max-[53rem]:rounded-none')
    expect(card?.className).toContain('max-[53rem]:border-0')
    expect(card?.className).toContain('max-[53rem]:shadow-none')
  })

  it('preserves the wide inset dialog treatment and the default behavior of other overlays', () => {
    render(
      <OverlayView onClose={vi.fn()} title="Default dialog">
        <p>default content</p>
      </OverlayView>
    )

    const card = screen.getByRole('dialog', { name: 'Default dialog' })
    const overlay = card.closest('[data-responsive-mode]')

    expect(overlay?.getAttribute('data-responsive-mode')).toBe('inset')
    expect(overlay?.className).toContain('sm:p-[calc(var(--titlebar-height)+0.875rem)]')
    expect(overlay?.className).not.toContain('max-[53rem]:!p-0')
    expect(card?.className).toContain('rounded-xl')
  })

  it('is a modal focus scope, closes once on Escape, locks scroll, and restores its opener', async () => {
    render(<OverlayHarness />)
    const opener = screen.getByRole('button', { name: 'Open profile' })

    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Profile dialog' })
    await waitFor(() => expect(dialog.contains(globalThis.document.activeElement)).toBe(true))
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(globalThis.document.body.style.overflow).toBe('hidden')

    const first = screen.getByRole('button', { name: 'First action' })
    const close = screen.getByRole('button', { name: /close/i })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    await waitFor(() => expect(dialog.contains(globalThis.document.activeElement)).toBe(true))

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    await waitFor(() => expect(dialog.contains(globalThis.document.activeElement)).toBe(true))

    fireEvent.keyDown(globalThis.document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Profile dialog' })).toBeNull())
    await waitFor(() => expect(globalThis.document.activeElement).toBe(opener))
    expect(globalThis.document.body.style.overflow).toBe('')
  })

  it('uses an explicit labelled-by relationship for account surfaces', () => {
    render(
      <OverlayView ariaLabelledBy="surface-title" onClose={vi.fn()}>
        <h1 id="surface-title">Account settings</h1>
      </OverlayView>
    )

    expect(screen.getByRole('dialog', { name: 'Account settings' }).getAttribute('aria-labelledby')).toBe('surface-title')
  })
})
