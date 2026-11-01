// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HERMES_CONFIG_KEY } from '@/app/hooks/use-config-record'
import type { HermesConnection } from '@/global'
import { queryClient } from '@/lib/query-client'
import { $connection, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import type * as Windows from '@/store/windows'

import { REAL_PROFILE_RESET_KEY, watchRealProfileReset } from './real-profile-reset'

const windows = vi.hoisted(() => ({ auxiliary: false, peer: false, watch: false }))

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof Windows>()),
  isAuxiliaryWindow: () => windows.auxiliary,
  isPeerInstanceWindow: () => windows.peer,
  isWatchWindow: () => windows.watch
}))

interface ApiRequest {
  body?: { config: { browser: { use_real_profile: boolean } } }
  method?: string
  path: string
  profile?: string
}

/** A fake install: profile → the setting on disk. Reads and writes go through what the real API helpers send. */
function install(disk: Record<string, boolean>) {
  const state = {
    calls: [] as ApiRequest[],
    disk,
    failList: 0,
    failRead: new Set<string>(),
    failWrite: new Set<string>(),
    holdList: null as null | Promise<void>,
    holdRead: {} as Record<string, Promise<void>>
  }

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      api: vi.fn(async (request: ApiRequest) => {
        state.calls.push(request)

        if (request.path === '/api/profiles') {
          await state.holdList

          if (state.failList > 0) {
            state.failList -= 1

            throw new Error('backend busy')
          }

          return { profiles: Object.keys(state.disk).map(name => ({ is_default: name === 'default', name })) }
        }

        const profile = request.profile ?? 'default'

        if (request.method === 'PUT') {
          if (state.failWrite.has(profile)) {
            throw new Error('write refused')
          }

          state.disk[profile] = request.body!.config.browser.use_real_profile

          return { ok: true }
        }

        await state.holdRead[profile]

        if (state.failRead.has(profile)) {
          throw new Error('read refused')
        }

        // include_defaults=false: an install that never touched it has no key at all.
        return state.disk[profile] ? { browser: { use_real_profile: true } } : {}
      })
    }
  })

  return state
}

let stops: (() => void)[] = []

/** One launch: the watcher starts with the gateway already open, and everything it started finishes. */
async function launch(): Promise<void> {
  stops.push(watchRealProfileReset())
  await settle()
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

function quit(): void {
  stops.forEach(stop => stop())
  stops = []
}

function product(): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
}

function developer(): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('technical')
}

const writes = (state: ReturnType<typeof install>) => state.calls.filter(call => call.method === 'PUT')
const ledger = () => JSON.parse(window.localStorage.getItem(REAL_PROFILE_RESET_KEY) ?? 'null')

const OFF = { config: { browser: { use_real_profile: false } } }

beforeEach(() => {
  window.localStorage.clear()
  queryClient.clear()
  Object.assign(windows, { auxiliary: false, peer: false, watch: false })
  $connection.set({ mode: 'local' } as HermesConnection)
  $gatewayState.set('open')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

afterEach(() => {
  quit()
  $gatewayState.set('idle')
  $connection.set(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('someone who said yes to the old dialog', () => {
  it('goes off once in product mode and never again', async () => {
    product()
    const state = install({ default: true })

    await launch()

    expect(state.disk.default).toBe(false)
    expect(writes(state)).toEqual([{ body: OFF, method: 'PUT', path: '/api/config' }])
    expect(ledger()).toEqual({ complete: true, settled: ['default'] })

    quit()
    state.calls.length = 0
    await launch()

    expect(state.calls).toEqual([])
  })

  it('refreshes what the settings pages show', async () => {
    product()
    install({ default: true })
    queryClient.setQueryData(HERMES_CONFIG_KEY, { browser: { use_real_profile: true } })

    await launch()

    expect(queryClient.getQueryState(HERMES_CONFIG_KEY)?.isInvalidated).toBe(true)
  })

  it('waits in developer mode, then goes off once on reaching product mode', async () => {
    developer()
    const state = install({ default: true })

    await launch()

    expect(state.disk.default).toBe(true)
    expect(writes(state)).toEqual([])
    expect(ledger()).toEqual({ complete: false, settled: [] })

    setToolViewMode('product')
    await settle()

    expect(state.disk.default).toBe(false)
    expect(writes(state)).toHaveLength(1)
    expect(ledger()).toEqual({ complete: true, settled: ['default'] })
  })

  it('also waits when the switch comes on while in developer mode', async () => {
    setSingleThreadFlagForTest(false)
    setToolViewMode('technical')
    const state = install({ default: true })

    await launch()

    expect(state.calls).toEqual([])

    setSingleThreadFlagForTest(true)
    await settle()

    expect(state.disk.default).toBe(true)
    expect(writes(state)).toEqual([])
    expect(ledger()).toEqual({ complete: false, settled: [] })
  })
})

describe('turning it on by hand is not undone', () => {
  it('after it went off in product mode, however often the modes change', async () => {
    product()
    const state = install({ default: true })

    await launch()
    expect(state.disk.default).toBe(false)

    developer()
    state.disk.default = true
    state.calls.length = 0
    await settle()
    setToolViewMode('product')
    await settle()
    quit()
    await launch()

    expect(state.disk.default).toBe(true)
    expect(state.calls).toEqual([])
  })

  it('when it was off at the first look in developer mode', async () => {
    developer()
    const state = install({ default: false })

    await launch()
    expect(ledger()).toEqual({ complete: true, settled: ['default'] })

    state.disk.default = true
    state.calls.length = 0
    setToolViewMode('product')
    await settle()
    quit()
    await launch()

    expect(state.disk.default).toBe(true)
    expect(state.calls).toEqual([])
  })

  it('when it was off at the first look in product mode', async () => {
    product()
    const state = install({ default: false })

    await launch()

    expect(writes(state)).toEqual([])
    expect(ledger()).toEqual({ complete: true, settled: ['default'] })

    state.disk.default = true
    state.calls.length = 0
    quit()
    await launch()

    expect(state.disk.default).toBe(true)
    expect(state.calls).toEqual([])
  })

  it('on one assistant while another still waits', async () => {
    developer()
    const state = install({ default: false, 'apex-bot-2': true })

    await launch()
    expect(ledger()).toEqual({ complete: false, settled: ['default'] })

    state.disk.default = true
    setToolViewMode('product')
    await settle()

    expect(state.disk).toEqual({ default: true, 'apex-bot-2': false })
    expect(writes(state)).toEqual([{ body: OFF, method: 'PUT', path: '/api/config', profile: 'apex-bot-2' }])
    expect(ledger()).toEqual({ complete: true, settled: ['default', 'apex-bot-2'] })
  })
})

describe('every assistant', () => {
  it('reads each profile through its own scope and writes only the one that is on', async () => {
    product()
    const state = install({ default: false, 'apex-bot-2': true, 'apex-bot-3': false })

    await launch()

    expect(state.calls).toEqual([
      expect.objectContaining({ path: '/api/profiles' }),
      { path: '/api/config?include_defaults=false' },
      { path: '/api/config?include_defaults=false', profile: 'apex-bot-2' },
      { body: OFF, method: 'PUT', path: '/api/config', profile: 'apex-bot-2' },
      { path: '/api/config?include_defaults=false', profile: 'apex-bot-3' }
    ])
    expect(state.disk).toEqual({ default: false, 'apex-bot-2': false, 'apex-bot-3': false })
  })

  it('stops looking once all are settled, so an assistant made later is not touched', async () => {
    product()
    const state = install({ default: false })

    await launch()
    quit()

    state.disk['apex-bot-2'] = true
    state.calls.length = 0
    await launch()

    expect(state.calls).toEqual([])
    expect(state.disk['apex-bot-2']).toBe(true)
  })
})

describe('the switch off', () => {
  it.each(['product', 'technical'] as const)('reads nothing and records nothing (%s view)', async toolView => {
    setSingleThreadFlagForTest(false)
    setToolViewMode(toolView)
    const state = install({ default: true })

    await launch()

    expect(state.calls).toEqual([])
    expect(state.disk.default).toBe(true)
    expect(window.localStorage.getItem(REAL_PROFILE_RESET_KEY)).toBeNull()
  })

  it('takes effect the moment product mode really starts', async () => {
    setSingleThreadFlagForTest(false)
    setToolViewMode('product')
    const state = install({ default: true })

    await launch()
    expect(state.calls).toEqual([])

    setSingleThreadFlagForTest(true)
    await settle()

    expect(state.disk.default).toBe(false)
    expect(writes(state)).toHaveLength(1)
  })
})

describe('failures settle nothing', () => {
  it('a refused write is tried again next launch, once', async () => {
    product()
    const state = install({ default: true })
    state.failWrite.add('default')

    await launch()

    expect(state.disk.default).toBe(true)
    expect(ledger()).toEqual({ complete: false, settled: [] })

    state.failWrite.clear()
    quit()
    await launch()

    expect(state.disk.default).toBe(false)
    expect(ledger()).toEqual({ complete: true, settled: ['default'] })
  })

  it('one unreadable profile does not hold up the others, and only it is read again', async () => {
    product()
    const state = install({ default: true, 'apex-bot-2': true })
    state.failRead.add('apex-bot-2')

    await launch()

    expect(state.disk).toEqual({ default: false, 'apex-bot-2': true })
    expect(ledger()).toEqual({ complete: false, settled: ['default'] })

    state.failRead.clear()
    state.calls.length = 0
    quit()
    await launch()

    expect(state.calls.filter(call => !call.method && call.path.startsWith('/api/config'))).toEqual([
      { path: '/api/config?include_defaults=false', profile: 'apex-bot-2' }
    ])
    expect(state.disk['apex-bot-2']).toBe(false)
  })

  it('a failed list records nothing and is tried again when the gateway comes back', async () => {
    product()
    const state = install({ default: true })
    state.failList = 1

    await launch()

    expect(state.disk.default).toBe(true)
    expect(window.localStorage.getItem(REAL_PROFILE_RESET_KEY)).toBeNull()

    $gatewayState.set('closed')
    $gatewayState.set('open')
    await settle()

    expect(state.disk.default).toBe(false)
  })

  it('an empty list records nothing', async () => {
    product()
    const state = install({})

    await launch()

    expect(state.calls).toHaveLength(1)
    expect(window.localStorage.getItem(REAL_PROFILE_RESET_KEY)).toBeNull()
  })

  it.each(['not json', '{"complete":"yes","settled":"default"}', '[]'])(
    'a damaged ledger reads as none: %s',
    async raw => {
      product()
      window.localStorage.setItem(REAL_PROFILE_RESET_KEY, raw)
      const state = install({ default: true })

      await launch()

      expect(state.disk.default).toBe(false)
      expect(ledger()).toEqual({ complete: true, settled: ['default'] })
    }
  )
})

describe('when it runs', () => {
  it('waits for the gateway', async () => {
    product()
    $gatewayState.set('connecting')
    const state = install({ default: true })

    await launch()
    expect(state.calls).toEqual([])

    $gatewayState.set('open')
    await settle()

    expect(state.disk.default).toBe(false)
  })

  it('leaves a remote gateway alone', async () => {
    product()
    $connection.set({ mode: 'remote' } as HermesConnection)
    const state = install({ default: true })

    await launch()

    expect(state.calls).toEqual([])
    expect(window.localStorage.getItem(REAL_PROFILE_RESET_KEY)).toBeNull()
  })

  it.each(['auxiliary', 'peer', 'watch'] as const)('leaves it to the primary window: %s', async kind => {
    product()
    windows[kind] = true
    const state = install({ default: true })

    await launch()

    expect(state.calls).toEqual([])
    expect(state.disk.default).toBe(true)
  })

  it('does not run over itself: triggers during a scan make one more, not a second write', async () => {
    product()
    const state = install({ default: true })

    let release = () => {}
    state.holdList = new Promise(resolve => (release = resolve))

    await launch()
    $gatewayState.set('closed')
    $gatewayState.set('open')
    $gatewayState.set('closed')
    $gatewayState.set('open')
    await settle()

    expect(state.calls.filter(call => call.path === '/api/profiles')).toHaveLength(1)

    release()
    await settle()

    expect(writes(state)).toHaveLength(1)
  })

  it('a switch to product mode after a profile was already passed over goes back for it', async () => {
    developer()
    const state = install({ default: true, 'apex-bot-2': true })

    let release = () => {}
    state.holdRead['apex-bot-2'] = new Promise(resolve => (release = resolve))

    await launch()

    // default was read in developer mode and left waiting; this scan is now parked on the next profile.
    expect(state.disk.default).toBe(true)

    setToolViewMode('product')
    await settle()
    release()
    await settle()

    expect(state.disk).toEqual({ default: false, 'apex-bot-2': false })
    expect(ledger()).toEqual({ complete: true, settled: ['apex-bot-2', 'default'] })
  })

  it('a switch to product mode during a developer-mode scan is not lost', async () => {
    developer()
    const state = install({ default: true })

    let release = () => {}
    state.holdList = new Promise(resolve => (release = resolve))

    await launch()
    setToolViewMode('product')
    await settle()
    state.holdList = null
    release()
    await settle()

    expect(state.disk.default).toBe(false)
    expect(writes(state)).toHaveLength(1)
    expect(ledger()).toEqual({ complete: true, settled: ['default'] })
  })
})
