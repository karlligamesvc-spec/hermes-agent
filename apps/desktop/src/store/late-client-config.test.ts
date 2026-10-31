/**
 * hc-1127: the window side of a new install's first launch. A config that lands after
 * a window opened has to reach every switch that window reads once. The two reads at
 * startup sit about 20 ms apart, and a config landing between them left a real 0.17.69
 * install with multi-bot on and single-thread off (hc-1126).
 */

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
const BOT_HINT = 'apex.desktop.feature.multi-bot'

/** A bridge whose reads wait to be answered, in the order the stores asked. */
function install() {
  const listeners: Array<(next: DesktopClientConfigState) => void> = []
  const answers: Array<(state: DesktopClientConfigState) => void> = []
  const listenersAtEachRead: number[] = []

  const get = vi.fn(
    () =>
      new Promise<DesktopClientConfigState>(resolve => {
        listenersAtEachRead.push(listeners.length)
        answers.push(resolve)
      })
  )

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

  return {
    answer: (index: number, state: DesktopClientConfigState) => answers[index](state),
    arrive: (next: DesktopClientConfigState) => listeners.forEach(listener => listener(next)),
    get,
    listenersAtEachRead
  }
}

async function stores() {
  vi.resetModules()

  return {
    bots: await import('@/store/single-thread-bots'),
    handoff: await import('@/store/single-thread-handoff'),
    single: await import('@/store/single-thread')
  }
}

async function settled(answered: unknown) {
  await Promise.resolve(answered)
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'hermesDesktop')
  localStorage.clear()
})

describe('a config that lands after the window opened', () => {
  it('between the two startup reads: both switches end on, not one of each (hc-1126)', async () => {
    const bridge = install()
    const { bots, single } = await stores()

    bridge.answer(0, NOTHING) // single-thread read before it landed
    await settled(single.loadSingleThreadFlag())
    expect(single.$singleThreadFlag.get()).toBe(false)

    bridge.arrive(ON)
    bridge.answer(1, ON) // multi-bot read after it landed
    await settled(undefined)

    expect(single.$singleThreadMode.get()).toBe(true)
    expect(bots.$multiBotFlag.get()).toBe(true)
    expect(localStorage.getItem(HINT)).toBe('true')
    expect(localStorage.getItem(BOT_HINT)).toBe('true')
  })

  it('every store listens before it reads, so nothing can land in a gap', async () => {
    const bridge = install()

    await stores()

    // The single-thread store reads first, then multi-bot: each has its own listener up by then.
    expect(bridge.listenersAtEachRead).toEqual([1, 2])
  })

  it('after both reads: reaches all three switches read once per window, and the cap', async () => {
    const bridge = install()
    const { bots, handoff, single } = await stores()

    bridge.answer(0, NOTHING)
    bridge.answer(1, NOTHING)
    await settled(Promise.all([single.loadSingleThreadFlag(), bots.loadMultiBotFlag()]))
    expect(single.$singleThreadFlag.get()).toBe(false)
    expect(bots.$multiBotFlag.get()).toBe(false)

    bridge.arrive(ON)

    expect(single.$singleThreadMode.get()).toBe(true)
    expect(bots.$multiBotFlag.get()).toBe(true)
    expect(bots.$multiBotMax.get()).toBe(3)
    expect(handoff.$multiBotHandoffFlag.get()).toBe(true)
    expect(localStorage.getItem(HINT)).toBe('true')
  })

  it('the once-per-window reads answer from the new config, not the first one', async () => {
    const bridge = install()
    const { bots, handoff, single } = await stores()

    bridge.answer(0, NOTHING)
    bridge.answer(1, NOTHING)
    expect(await single.loadSingleThreadFlag()).toBe(false)
    expect(await bots.loadMultiBotFlag()).toBe(false)

    // The relay store reads on demand, not at import.
    const relay = handoff.loadMultiBotHandoffFlag()

    bridge.answer(2, NOTHING)
    expect(await relay).toBe(false)

    const reads = bridge.get.mock.calls.length

    bridge.arrive(ON)

    const again = [single.loadSingleThreadFlag(), bots.loadMultiBotFlag(), handoff.loadMultiBotHandoffFlag()]

    expect(bridge.get.mock.calls.length).toBe(reads + 3)
    bridge.answer(reads, ON)
    bridge.answer(reads + 1, ON)
    bridge.answer(reads + 2, ON)
    expect(await Promise.all(again)).toEqual([true, true, true])
  })

  it('an install switch still wins', async () => {
    const bridge = install()
    const { bots, single } = await stores()

    bridge.answer(0, NOTHING)
    bridge.answer(1, NOTHING)
    await settled(Promise.all([single.loadSingleThreadFlag(), bots.loadMultiBotFlag()]))

    bridge.arrive({ ...ON, installSwitches: { multi_bot: false, single_thread: false } })

    expect(single.$singleThreadFlag.get()).toBe(false)
    expect(bots.$multiBotFlag.get()).toBe(false)
  })

  it('an older main process has no such bridge, and the stores still read', async () => {
    const get = vi.fn(async () => ON)

    Object.assign(window, { hermesDesktop: { clientConfig: { get } } })

    const { single } = await stores()

    expect(await single.loadSingleThreadFlag()).toBe(true)
  })
})
