import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $singleThreadFlag,
  $singleThreadMode,
  loadSingleThreadFlag,
  setSingleThreadFlagForTest,
  SINGLE_THREAD_HINT_KEY,
  singleThreadSwitchFrom
} from './single-thread'
import { setToolViewMode } from './tool-view'

const originalBridge = window.hermesDesktop

function withClientConfig(get: () => Promise<unknown>) {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { clientConfig: { get } } })
}

afterEach(() => {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
  setToolViewMode('product')
  setSingleThreadFlagForTest(false)
  window.localStorage.removeItem(SINGLE_THREAD_HINT_KEY)
})

describe('hc-1014 desktop_features.single_thread', () => {
  it.each([
    [{ payload: { desktop_features: { single_thread: true } } }, true],
    [{ payload: { desktop_features: { single_thread: 'true' } } }, false],
    [{ payload: { desktop_features: { daily_ideas: true } } }, false],
    [{ payload: null }, false],
    [{ installSwitches: { single_thread: true }, payload: null }, true],
    [{ installSwitches: { single_thread: false }, payload: { desktop_features: { single_thread: true } } }, false],
    [{ installSwitches: { daily_ideas: true }, payload: { desktop_features: { single_thread: true } } }, true],
    [null, false]
  ])('%j reads as %j', (state, expected) => {
    expect(singleThreadSwitchFrom(state as Parameters<typeof singleThreadSwitchFrom>[0])).toBe(expected)
  })

  it('is product mode only while 开发者模式 is off', () => {
    setSingleThreadFlagForTest(true)
    expect($singleThreadMode.get()).toBe(true)

    setToolViewMode('technical')
    expect($singleThreadMode.get()).toBe(false)

    setToolViewMode('product')
    setSingleThreadFlagForTest(false)
    expect($singleThreadMode.get()).toBe(false)
  })

  it('reads the cached client config once per window and remembers the answer for the next launch', async () => {
    const get = vi.fn(async () => ({
      appliedVersion: 1,
      installSwitches: { single_thread: true },
      payload: null,
      version: 1
    }))

    setSingleThreadFlagForTest(false)
    withClientConfig(get)

    await expect(Promise.all([loadSingleThreadFlag(), loadSingleThreadFlag()])).resolves.toEqual([true, true])
    expect(get).toHaveBeenCalledTimes(1)
    expect($singleThreadFlag.get()).toBe(true)
    expect(window.localStorage.getItem(SINGLE_THREAD_HINT_KEY)).toBe('true')
  })

  it('keeps the last known value when the bridge is missing or fails', async () => {
    setSingleThreadFlagForTest(true)
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: {} })
    await expect(loadSingleThreadFlag()).resolves.toBe(true)

    setSingleThreadFlagForTest(true)
    withClientConfig(async () => {
      throw new Error('ipc down')
    })
    await expect(loadSingleThreadFlag()).resolves.toBe(true)
  })

  it('turns off when the platform turns it off', async () => {
    setSingleThreadFlagForTest(true)
    withClientConfig(async () => ({ appliedVersion: 2, payload: { desktop_features: {} }, version: 2 }))

    await expect(loadSingleThreadFlag()).resolves.toBe(false)
    expect(window.localStorage.getItem(SINGLE_THREAD_HINT_KEY)).toBe('false')
  })
})
