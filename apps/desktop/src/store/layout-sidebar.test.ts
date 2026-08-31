import { beforeEach, describe, expect, it } from 'vitest'

import {
  $sidebarWidth,
  CHAT_SIDEBAR_PANE_ID,
  reconcileSidebarWidthOverride,
  setSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from './layout'
import { $paneStates, getPaneStateSnapshot, setPaneWidthOverride } from './panes'

describe('APEX sidebar geometry', () => {
  beforeEach(() => {
    $paneStates.set({ [CHAT_SIDEBAR_PANE_ID]: { open: true } })
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
})
