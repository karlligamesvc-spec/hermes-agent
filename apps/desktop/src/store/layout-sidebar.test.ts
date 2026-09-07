import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'

import {
  $sidebarWidth,
  CHAT_SIDEBAR_PANE_ID,
  dismissNarrowSidebarOverlay,
  reconcileSidebarWidthOverride,
  setSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from './layout'
import { $paneStates, getPaneStateSnapshot, setPaneWidthOverride } from './panes'

function setNarrowViewport(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches }))
  })
}

describe('APEX sidebar geometry', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    $paneStates.set({ [CHAT_SIDEBAR_PANE_ID]: { open: true } })
  })

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
  })

  it('uses the compact prototype width for a fresh renderer', () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(237)
    expect($sidebarWidth.get()).toBe(237)
  })

  it('drops a legacy 360px override instead of carrying the old wide rail forward', () => {
    setPaneWidthOverride(CHAT_SIDEBAR_PANE_ID, 360)
    expect($sidebarWidth.get()).toBe(360)

    reconcileSidebarWidthOverride()

    expect(getPaneStateSnapshot(CHAT_SIDEBAR_PANE_ID)?.widthOverride).toBeUndefined()
    expect($sidebarWidth.get()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('preserves valid user resizing and clamps new resize writes to the current contract', () => {
    setPaneWidthOverride(CHAT_SIDEBAR_PANE_ID, 220)
    reconcileSidebarWidthOverride()
    expect($sidebarWidth.get()).toBe(220)

    setSidebarWidth(120)
    expect($sidebarWidth.get()).toBe(SIDEBAR_MIN_WIDTH)

    setSidebarWidth(400)
    expect($sidebarWidth.get()).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('dismisses only the transient narrow overlay without changing the docked sidebar preference', () => {
    setNarrowViewport(true)
    const events: CustomEvent[] = []
    const onToggle = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, onToggle)

    expect(dismissNarrowSidebarOverlay()).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.detail).toEqual({ id: CHAT_SIDEBAR_PANE_ID, mode: 'close' })
    expect(getPaneStateSnapshot(CHAT_SIDEBAR_PANE_ID)?.open).toBe(true)

    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, onToggle)
  })

  it('does nothing on a wide window and preserves the docked sidebar', () => {
    setNarrowViewport(false)
    const onToggle = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, onToggle)

    expect(dismissNarrowSidebarOverlay()).toBe(false)
    expect(onToggle).not.toHaveBeenCalled()
    expect(getPaneStateSnapshot(CHAT_SIDEBAR_PANE_ID)?.open).toBe(true)

    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, onToggle)
  })
})
