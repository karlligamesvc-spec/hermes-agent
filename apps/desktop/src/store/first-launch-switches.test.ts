/**
 * hc-1127: the window side of a new install's first launch. A config that lands after
 * the window opened has to reach every switch that is read once per window.
 */

import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopClientConfigState } from '@/global'

const ON = {
  appliedVersion: 0,
  installSwitches: {},
  payload: { desktop_features: { multi_bot: true, multi_bot_handoff: true, multi_bot_max_v2: 3, single_thread: true } },
  version: 7
}

const NOTHING = { appliedVersion: 0, installSwitches: {}, payload: null, version: 0 }
const HINT = 'apex.desktop.feature.single-thread'

function install(state: DesktopClientConfigState) {
  const listeners: Array<(next: DesktopClientConfigState) => void> = []
  const get = vi.fn(async () => state)

  Object.assign(window, {
    hermesDesktop: {
      clientConfig: {
        get,
        onArrived: (callback: (next: DesktopClientConfigState) => void) => {
          listeners.push(callback)

          return () => undefined
        }
      }
    }
  })

  return { arrive: (next: DesktopClientConfigState) => listeners.forEach(listener => listener(next)), get, listeners }
}

async function modules() {
  vi.resetModules()

  return {
    bots: await import('@/store/single-thread-bots'),
    first: await import('@/store/first-launch-switches'),
    handoff: await import('@/store/single-thread-handoff'),
    single: await import('@/store/single-thread')
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'hermesDesktop')
  localStorage.clear()
})

describe('the window', () => {
  it('main.tsx follows a late config before the shell renders', () => {
    const source = fs
      .readFileSync(path.join(import.meta.dirname, '..', 'main.tsx'), 'utf8')
      .split('\n')
      .map(line => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n')

    expect(source.indexOf('followLateClientConfig()')).toBeGreaterThan(-1)
    expect(source.indexOf('followLateClientConfig()')).toBeLessThan(source.indexOf("createRoot(document.getElementById('root')!)"))
  })

  // A new install's first window has no hint and the config is already cached: the stores
  // start off and settle on the read, behind the boot overlay.
  it('a first window reads the config main fetched before opening it', async () => {
    install(ON)
    const { bots, single } = await modules()

    await Promise.all([single.loadSingleThreadFlag(), bots.loadMultiBotFlag()])

    expect(single.$singleThreadMode.get()).toBe(true)
    expect(bots.$multiBotFlag.get()).toBe(true)
    expect(localStorage.getItem(HINT)).toBe('true')
  })
})

describe('a config that lands after the window opened', () => {
  it('reaches all three switches read once per window, and the cap', async () => {
    const bridge = install(NOTHING)
    const { bots, first, handoff, single } = await modules()

    await single.loadSingleThreadFlag()
    await bots.loadMultiBotFlag()
    expect(single.$singleThreadFlag.get()).toBe(false)
    expect(bots.$multiBotFlag.get()).toBe(false)

    first.followLateClientConfig()
    bridge.arrive(ON)

    expect(single.$singleThreadMode.get()).toBe(true)
    expect(bots.$multiBotFlag.get()).toBe(true)
    expect(bots.$multiBotMax.get()).toBe(3)
    expect(handoff.$multiBotHandoffFlag.get()).toBe(true)
    expect(localStorage.getItem(HINT)).toBe('true')
  })

  it('the once-per-window reads answer from the new config, not the first one', async () => {
    const bridge = install(NOTHING)
    const { first, single } = await modules()

    expect(await single.loadSingleThreadFlag()).toBe(false)

    first.followLateClientConfig()
    bridge.get.mockResolvedValue(ON)
    bridge.arrive(ON)

    expect(await single.loadSingleThreadFlag()).toBe(true)
  })

  it('an install switch still wins', async () => {
    const bridge = install(NOTHING)
    const { first, single } = await modules()

    await single.loadSingleThreadFlag()
    first.followLateClientConfig()
    bridge.arrive({ ...ON, installSwitches: { single_thread: false } })

    expect(single.$singleThreadFlag.get()).toBe(false)
  })

  it('an older main process has no such bridge, and nothing breaks', async () => {
    Object.assign(window, { hermesDesktop: { clientConfig: { get: async () => NOTHING } } })
    const { first } = await modules()

    expect(() => first.followLateClientConfig()).not.toThrow()
  })
})
