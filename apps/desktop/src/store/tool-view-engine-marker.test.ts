// hc-1131: the engine learns developer mode from a marker main keeps in step with this store.
// The launch call matters as much as the flip: someone already in developer mode when this ships has no marker yet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TECHNICAL_KEY = 'hermes.desktop.toolView.technical'

function stubBridge(syncDeveloperMode?: (on: boolean) => Promise<unknown>) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = syncDeveloperMode ? { syncDeveloperMode } : {}
}

async function freshStore() {
  vi.resetModules()

  return import('./tool-view')
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
})

describe('telling the engine about developer mode', () => {
  it('reports product mode at launch', async () => {
    const sync = vi.fn(async () => undefined)

    stubBridge(sync)
    await freshStore()

    expect(sync.mock.calls).toEqual([[false]])
  })

  it('reports developer mode at launch when it was left on', async () => {
    const sync = vi.fn(async () => undefined)

    window.localStorage.setItem(TECHNICAL_KEY, 'true')
    stubBridge(sync)
    await freshStore()

    expect(sync.mock.calls).toEqual([[true]])
  })

  it('reports every flip', async () => {
    const sync = vi.fn(async () => undefined)

    stubBridge(sync)

    const { setToolViewMode } = await freshStore()

    setToolViewMode('technical')
    setToolViewMode('product')

    expect(sync.mock.calls).toEqual([[false], [true], [false]])
  })

  it('still loads without the bridge method', async () => {
    stubBridge()

    const { $toolViewMode } = await freshStore()

    expect($toolViewMode.get()).toBe('product')
  })

  it('still loads outside a window', async () => {
    vi.stubGlobal('window', undefined)

    try {
      const { $toolViewMode } = await freshStore()

      expect($toolViewMode.get()).toBe('product')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('swallows a failed report', async () => {
    const rejected = vi.fn()
    let reports = 0

    // Not vi.fn: it attaches handlers to a promise it returns, which would hide the unhandled rejection.
    const sync = () => {
      reports += 1

      return Promise.reject(new Error('main is gone'))
    }

    process.on('unhandledRejection', rejected)

    try {
      stubBridge(sync)
      await freshStore()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(reports).toBe(1)
      expect(rejected).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', rejected)
    }
  })
})
