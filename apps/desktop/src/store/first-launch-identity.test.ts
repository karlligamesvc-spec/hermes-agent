/**
 * hc-1127: what the launch-time switch stores do must not change for any launch
 * that already worked. Recorded on clean fork main b881175df2 before the fix, so a
 * drift in the off path, in developer mode or in a cached install shows up here.
 *
 * The trace is what a window's stores do from import until their read settles: the
 * flags they start from, the flags they end on, how often they asked main, and what
 * they wrote to storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopClientConfigState } from '@/global'

const ON = {
  desktop_features: { hypihub_apex: true, multi_bot: true, multi_bot_max: 4, multi_bot_max_v2: 5, single_thread: true }
}

const OFF = {
  desktop_features: { hypihub_apex: false, multi_bot: false, multi_bot_max: 4, single_thread: false }
}

const NOTHING = { appliedVersion: 0, installSwitches: {}, payload: null, version: 0 }
const CACHED_ON = { appliedVersion: 7, installSwitches: {}, payload: ON, version: 7 }
const CACHED_OFF = { appliedVersion: 8, installSwitches: {}, payload: OFF, version: 8 }

const HINT = 'apex.desktop.feature.single-thread'
const BOT_HINT = 'apex.desktop.feature.multi-bot'
const TECHNICAL = 'hermes.desktop.toolView.technical'

const CASES: Record<string, { state: DesktopClientConfigState; storage?: Record<string, string> }> = {
  'cached on, hint on (a returning user)': { state: CACHED_ON, storage: { [BOT_HINT]: 'true', [HINT]: 'true' } },
  'cached on, hint off (the launch after a rollout)': {
    state: CACHED_ON,
    storage: { [BOT_HINT]: 'false', [HINT]: 'false' }
  },
  'cached on, no hint (first launch of a new shell on an old home)': { state: CACHED_ON },
  'cached on, developer mode': { state: CACHED_ON, storage: { [HINT]: 'true', [TECHNICAL]: 'true' } },
  'cached off, hint off': { state: CACHED_OFF, storage: { [BOT_HINT]: 'false', [HINT]: 'false' } },
  'cached off, hint on (the launch after a rollback)': {
    state: CACHED_OFF,
    storage: { [BOT_HINT]: 'true', [HINT]: 'true' }
  },
  'cached off, no hint': { state: CACHED_OFF },
  'nothing cached, no hint': { state: NOTHING },
  'nothing cached, hint off': { state: NOTHING, storage: { [BOT_HINT]: 'false', [HINT]: 'false' } },
  'install switch 0 over a platform on': {
    state: { ...CACHED_ON, installSwitches: { multi_bot: false, single_thread: false } }
  },
  'install switch 1 over nothing cached': {
    state: { ...NOTHING, installSwitches: { multi_bot: true, single_thread: true } }
  }
}

async function traceFor({ state, storage = {} }: (typeof CASES)[string]) {
  localStorage.clear()

  for (const [key, value] of Object.entries(storage)) {
    localStorage.setItem(key, value)
  }

  // Node 26 swaps localStorage for a plain object in vitest.setup.ts; spy on whichever owns setItem.
  const owner = localStorage instanceof Storage ? Storage.prototype : localStorage
  const writes: string[] = []
  const realSet = owner.setItem

  const spy = vi.spyOn(owner, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith('apex.desktop.feature.')) {
      writes.push(`${key}=${value}`)
    }

    realSet.call(this, key, value)
  })

  // Held until both stores are imported: `start` is what a first render would see.
  let answer = (_state: DesktopClientConfigState) => {}
  const answered = new Promise<DesktopClientConfigState>(resolve => (answer = resolve))
  const get = vi.fn(() => answered)
  vi.stubGlobal('hermesDesktop', undefined)
  Object.assign(window, { hermesDesktop: { clientConfig: { get } } })

  vi.resetModules()

  const single = await import('@/store/single-thread')
  const bots = await import('@/store/single-thread-bots')

  const start = {
    multiBot: bots.$multiBotFlag.get(),
    singleThread: single.$singleThreadFlag.get(),
    singleThreadMode: single.$singleThreadMode.get()
  }

  answer(state)
  await Promise.all([single.loadSingleThreadFlag(), bots.loadMultiBotFlag()])

  const end = {
    multiBot: bots.$multiBotFlag.get(),
    multiBotMax: bots.$multiBotMax.get(),
    singleThread: single.$singleThreadFlag.get(),
    singleThreadMode: single.$singleThreadMode.get()
  }

  spy.mockRestore()

  return { end, reads: get.mock.calls.length, start, writes }
}

describe('launch-time switch stores (hc-1127 identity)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'hermesDesktop')
    localStorage.clear()
  })

  it('every launch traces as recorded on clean main', async () => {
    const traces: Record<string, unknown> = {}

    for (const [name, launch] of Object.entries(CASES)) {
      traces[name] = await traceFor(launch)
    }

    await expect(`${JSON.stringify(traces, null, 2)}\n`).toMatchFileSnapshot(
      '../__identity__/first-launch/store-trace.json'
    )
  })
})
