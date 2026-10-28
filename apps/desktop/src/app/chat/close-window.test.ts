/**
 * hc-1100: ⌘W / File › Close in single-thread product mode on macOS closes the
 * window (the app and a running turn stay); everywhere else it is the tab verb
 * it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $freshSessionRequest } from '@/store/profile'
import { $activeSessionId } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { closeActiveTabOrWindow } from './close-window'

const platform = vi.hoisted(() => ({ mac: true }))

vi.mock('@/lib/keybinds/combo', async importActual => {
  const actual = await importActual<Record<string, unknown>>()

  return {
    ...actual,
    get IS_MAC() {
      return platform.mac
    }
  }
})

let closed = 0

beforeEach(() => {
  closed = 0
  vi.spyOn(window, 'close').mockImplementation(() => {
    closed += 1
  })
  $activeSessionId.set('runtime-1')
  setToolViewMode('product')
  platform.mac = true
})

afterEach(() => {
  vi.restoreAllMocks()
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  setToolViewMode('product')
})

describe('closeActiveTabOrWindow', () => {
  it('product mode on macOS: nothing else to close, so the window closes', () => {
    $singleThreadFlag.set(true)
    const fresh = $freshSessionRequest.get()

    expect(closeActiveTabOrWindow()).toBe(true)
    expect(closed).toBe(1)
    expect($freshSessionRequest.get()).toBe(fresh)
  })

  it.each([
    ['the switch off', false, 'product', true],
    ['developer mode', true, 'technical', true],
    ['product mode on Windows / Linux', true, 'product', false]
  ] as const)('%s: the workspace tab empties into a fresh draft, the window stays', (_name, flag, mode, mac) => {
    $singleThreadFlag.set(flag)
    setToolViewMode(mode)
    platform.mac = mac
    const fresh = $freshSessionRequest.get()

    expect(closeActiveTabOrWindow()).toBe(true)
    expect(closed).toBe(0)
    expect($freshSessionRequest.get()).toBe(fresh + 1)
  })
})
