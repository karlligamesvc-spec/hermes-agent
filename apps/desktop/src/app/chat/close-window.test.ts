/**
 * hc-1100: ⌘W / File › Close in single-thread product mode on macOS closes the
 * window (the app and a running turn stay); everywhere else it is the tab verb
 * it was.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  it('product mode on macOS: nothing else to close, so main closes the window (the red button’s path)', () => {
    $singleThreadFlag.set(true)

    const closeWindow = vi.fn()

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { closeWindow }
    const fresh = $freshSessionRequest.get()

    try {
      expect(closeActiveTabOrWindow()).toBe(true)
    } finally {
      ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
    }

    expect(closeWindow).toHaveBeenCalledTimes(1)
    expect(closed).toBe(0)
    expect($freshSessionRequest.get()).toBe(fresh)
  })

  it('an older shell without the bridge call closes the window from the page', () => {
    $singleThreadFlag.set(true)

    expect(closeActiveTabOrWindow()).toBe(true)
    expect(closed).toBe(1)
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

describe('who calls it', () => {
  const source = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8').replace(/\/\/.*$/gm, '')

  it('⌘W and File › Close (the close-preview-requested IPC) go through it', () => {
    expect(source('../contrib/hooks/use-desktop-integrations.ts')).toMatch(
      /onClosePreviewRequested\?\.\(\s*\(\) => void closeActiveTabOrWindow\(/
    )
  })

  it('the Windows / Linux Ctrl+W keybind keeps the tab verb', () => {
    expect(source('../hooks/use-keybinds.ts')).toMatch(/'view\.closeTab': \(\) => void closeActiveTab\(/)
  })
})
