import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ResponsiveRouteDrawer, ROUTE_DRAWER_WIDE_QUERY } from './responsive-route-drawer'

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<() => void>()

  const media = {
    get matches() {
      return matches
    },
    media: ROUTE_DRAWER_WIDE_QUERY,
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true
  } as unknown as MediaQueryList

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media)
  )

  return (next: boolean) => {
    matches = next
    listeners.forEach(listener => listener())
  }
}

function DrawerHarness() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open run
      </button>
      {open && (
        <ResponsiveRouteDrawer onClose={() => setOpen(false)} title="Run details">
          <button type="button">Inside action</button>
        </ResponsiveRouteDrawer>
      )}
    </>
  )
}

function renderHarness() {
  return render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <DrawerHarness />
      </I18nProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  globalThis.document.body.style.overflow = ''
})

describe('ResponsiveRouteDrawer', () => {
  it('uses a full-screen object surface below 1100px and a right drawer at the wide breakpoint', async () => {
    const setWide = installMatchMedia(false)

    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }))

    const drawer = screen.getByRole('dialog', { name: 'Run details' })

    expect(drawer.getAttribute('data-layout')).toBe('fullscreen')
    expect(drawer.className).toContain('min-[1100px]:w-[min(35rem,48vw)]')

    setWide(true)
    await waitFor(() => expect(drawer.getAttribute('data-layout')).toBe('drawer'))
  })

  it('traps focus, closes once on Escape, restores focus, and releases the scroll lock', async () => {
    installMatchMedia(true)
    renderHarness()
    const opener = screen.getByRole('button', { name: 'Open run' })

    opener.focus()
    fireEvent.click(opener)

    const drawer = screen.getByRole('dialog', { name: 'Run details' })

    await waitFor(() => expect(drawer.contains(globalThis.document.activeElement)).toBe(true))
    expect(globalThis.document.body.style.overflow).toBe('hidden')

    opener.focus()
    await waitFor(() => expect(drawer.contains(globalThis.document.activeElement)).toBe(true))

    fireEvent.keyDown(globalThis.document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run details' })).toBeNull())
    expect(globalThis.document.activeElement).toBe(opener)
    expect(globalThis.document.body.style.overflow).toBe('')
  })

  it('makes route-surface motion opt out under reduced-motion preferences', () => {
    installMatchMedia(false)
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }))

    const drawer = screen.getByRole('dialog', { name: 'Run details' })
    const backdrop = globalThis.document.querySelector('[data-route-drawer-backdrop]')

    expect(drawer.className).toContain('motion-reduce:animate-none')
    expect(drawer.className).toContain('motion-reduce:transition-none')
    expect(backdrop?.className).toContain('motion-reduce:animate-none')
  })
})
