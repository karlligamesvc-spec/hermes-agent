/**
 * hc-1127: the first launch of a new install fetched the platform config after the
 * window and the engine had already read "nothing", so it opened on the old shell and
 * only reached product mode after quitting and reopening. These pin the order a launch
 * settles in, with the real switch rules, and that a cached install did not change.
 *
 * Run with: npx vitest run electron/apex-client-config-sync.test.ts --project electron
 */

import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientConfigSync, FIRST_LAUNCH_CONFIG_WAIT_MS, type StoredClientConfig } from './apex-client-config-sync'
import { HYPIHUB_APEX_ACTIVE_ENV } from './apex-hypihub'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import { MULTI_BOT_ACTIVE_ENV } from './apex-profile-homes'
import { SINGLE_THREAD_ACTIVE_ENV } from './apex-single-thread'

const ON = { desktop_features: { hypihub_apex: true, multi_bot: true, single_thread: true } }
const OFF = { desktop_features: { hypihub_apex: false, multi_bot: false, single_thread: false } }
const EMPTY: StoredClientConfig = { appliedVersion: 0, fetchedAt: null, payload: null, version: 0 }
const CACHED_ON: StoredClientConfig = { appliedVersion: 7, fetchedAt: 1, payload: ON, version: 7 }

function harness(initial: StoredClientConfig, fetchJson: (url: string) => Promise<unknown>) {
  const env: Record<string, string | undefined> = {}
  const events: string[] = []
  const lines: string[] = []
  const urls: string[] = []
  let stored = initial

  const sync = createClientConfigSync({
    apiBase: () => 'https://platform.invalid',
    applySwitches: payload => {
      events.push('switches')
      applyDesktopFeatureSwitches(env, payload)
    },
    broadcast: state => {
      events.push(`broadcast v${state.version}`)
    },
    fetchJson: url => {
      urls.push(url)
      events.push('fetch')

      return fetchJson(url)
    },
    log: line => lines.push(line),
    read: () => stored,
    write: next => {
      events.push(`store v${next.version}`)
      stored = next
    }
  })

  return { env, events, lines, stored: () => stored, sync, urls }
}

/** The order main opens the first window in: settle, then create it. */
async function openFirstWindow(h: ReturnType<typeof harness>, seen: { engineEnv?: string | undefined }) {
  await h.sync.settleBeforeFirstWindow()
  h.events.push('createWindow')
  seen.engineEnv = h.env[SINGLE_THREAD_ACTIVE_ENV]
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a launch with nothing cached', () => {
  it('opens the window after the config landed, with the engine environment already settled', async () => {
    let answer = (_body: unknown) => {}
    const h = harness(EMPTY, () => new Promise(resolve => (answer = resolve)))
    const seen: { engineEnv?: string } = {}

    const opened = openFirstWindow(h, seen)
    await vi.advanceTimersByTimeAsync(FIRST_LAUNCH_CONFIG_WAIT_MS - 1)
    expect(h.events).toEqual(['fetch'])
    expect(h.sync.holdingFirstWindow()).toBe(true)

    answer({ version: 7, payload: ON })
    await opened

    expect(h.events).toEqual(['fetch', 'store v7', 'switches', 'broadcast v7', 'createWindow'])
    expect(seen.engineEnv).toBe('1')
    expect(h.env[MULTI_BOT_ACTIVE_ENV]).toBe('1')
    expect(h.env[HYPIHUB_APEX_ACTIVE_ENV]).toBe('1')
    expect(h.sync.holdingFirstWindow()).toBe(false)
    expect(h.stored()).toMatchObject({ appliedVersion: 0, payload: ON, version: 7 })
  })

  it('waits no longer than the cap on a connection that never answers, and the window opens off', async () => {
    const h = harness(EMPTY, () => new Promise(() => undefined))
    const seen: { engineEnv?: string } = {}

    const opened = openFirstWindow(h, seen)
    await vi.advanceTimersByTimeAsync(FIRST_LAUNCH_CONFIG_WAIT_MS)
    await opened

    expect(h.events).toEqual(['fetch', 'createWindow'])
    expect(seen.engineEnv).toBeUndefined()
    expect(h.sync.holdingFirstWindow()).toBe(false)
    expect(h.stored()).toEqual(EMPTY)
  })

  it.each([
    ['offline', () => Promise.reject(new Error('getaddrinfo ENOTFOUND'))],
    ['no active config', () => Promise.reject(new Error('404: not found'))],
    ['garbage body', () => Promise.resolve({ version: 'x' })]
  ])('%s: opens at once, without waiting out the cap, on the cached nothing', async (_name, respond) => {
    const h = harness(EMPTY, respond)
    const seen: { engineEnv?: string } = {}

    await openFirstWindow(h, seen)

    expect(vi.getTimerCount()).toBe(0)
    expect(h.events).toEqual(['fetch', 'createWindow'])
    expect(seen.engineEnv).toBeUndefined()
    expect(h.stored()).toEqual(EMPTY)
  })

  it('a config landing after the window opened settles the switches and tells the window, once', async () => {
    let answer = (_body: unknown) => {}
    const h = harness(EMPTY, () => new Promise(resolve => (answer = resolve)))

    const opened = openFirstWindow(h, {})
    await vi.advanceTimersByTimeAsync(FIRST_LAUNCH_CONFIG_WAIT_MS)
    await opened
    void h.sync.refresh('boot')

    answer({ version: 7, payload: ON })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.events).toEqual(['fetch', 'createWindow', 'store v7', 'switches', 'broadcast v7'])
    expect(h.env[SINGLE_THREAD_ACTIVE_ENV]).toBe('1')
  })

  it('the first fetch is the boot check: one request, not two', async () => {
    const h = harness(EMPTY, async () => ({ version: 7, payload: ON }))

    await openFirstWindow(h, {})
    await h.sync.refresh('boot')

    expect(h.urls).toEqual(['https://platform.invalid/api/v1/desktop/client-config'])
    expect(h.lines).toEqual(['[client-config] stored platform config v7 (first-launch)'])
  })

  it('a platform that turned the switch off is right on the first launch, and nothing flips', async () => {
    const h = harness(EMPTY, async () => ({ version: 8, payload: OFF }))
    const seen: { engineEnv?: string } = {}

    await openFirstWindow(h, seen)

    expect(seen.engineEnv).toBeUndefined()
    expect(h.env[MULTI_BOT_ACTIVE_ENV]).toBeUndefined()
    expect(h.stored()).toMatchObject({ payload: OFF, version: 8 })
  })

  it('this install keeps its own say: APEXNODES_SINGLE_THREAD wins both ways', async () => {
    const off = harness(EMPTY, async () => ({ version: 7, payload: ON }))
    off.env.APEXNODES_SINGLE_THREAD = '0'
    await openFirstWindow(off, {})
    expect(off.env[SINGLE_THREAD_ACTIVE_ENV]).toBeUndefined()
    expect(off.env[MULTI_BOT_ACTIVE_ENV]).toBeUndefined()

    const on = harness(EMPTY, async () => ({ version: 8, payload: OFF }))
    on.env.APEXNODES_SINGLE_THREAD = '1'
    await openFirstWindow(on, {})
    expect(on.env[SINGLE_THREAD_ACTIVE_ENV]).toBe('1')
  })

  it('sign-in waits for the config before it goes on, when the launch never got one', async () => {
    const respond = vi
      .fn<(url: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('offline at launch'))
      .mockResolvedValueOnce({ version: 7, payload: ON })

    const h = harness(EMPTY, respond)

    await openFirstWindow(h, {})
    expect(h.env[SINGLE_THREAD_ACTIVE_ENV]).toBeUndefined()

    await h.sync.settleBeforeSignInFinishes()
    h.events.push('commit key')

    expect(h.events).toEqual(['fetch', 'createWindow', 'fetch', 'store v7', 'switches', 'broadcast v7', 'commit key'])
    expect(h.env[SINGLE_THREAD_ACTIVE_ENV]).toBe('1')
  })

  it('sign-in gives up at the cap too, and a config arriving later still lands', async () => {
    let answer = (_body: unknown) => {}
    const h = harness(EMPTY, () => new Promise(resolve => (answer = resolve)))

    const settling = h.sync.settleBeforeSignInFinishes()
    await vi.advanceTimersByTimeAsync(FIRST_LAUNCH_CONFIG_WAIT_MS)
    await settling
    h.events.push('commit key')

    answer({ version: 7, payload: ON })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.events).toEqual(['fetch', 'commit key', 'store v7', 'switches', 'broadcast v7'])
  })
})

describe('an install with a config cached: exactly what it did before', () => {
  it('opens the window without a request or a timer', async () => {
    const h = harness(CACHED_ON, async () => ({ version: 7, unchanged: true }))

    await openFirstWindow(h, {})

    expect(h.events).toEqual(['createWindow'])
    expect(vi.getTimerCount()).toBe(0)
    expect(h.sync.holdingFirstWindow()).toBe(false)
  })

  it('the boot check asks with the known version and says unchanged', async () => {
    const h = harness(CACHED_ON, async () => ({ version: 7, unchanged: true }))

    await h.sync.refresh('boot')

    expect(h.urls).toEqual(['https://platform.invalid/api/v1/desktop/client-config?known_version=7'])
    expect(h.lines).toEqual(['[client-config] v7 unchanged (boot)'])
  })

  it('a newer version is stored for the next launch: the switches and the windows are left alone', async () => {
    const h = harness({ ...CACHED_ON, appliedVersion: 5 }, async () => ({ version: 8, payload: OFF }))

    await h.sync.refresh('boot')

    expect(h.events).toEqual(['fetch', 'store v8'])
    expect(h.stored()).toMatchObject({ appliedVersion: 5, payload: OFF, version: 8 })
    expect(h.lines).toEqual(['[client-config] stored platform config v8 (boot)'])
  })

  it('an older version never lands: a rollback is a new, higher version', async () => {
    const h = harness(CACHED_ON, async () => ({ version: 6, payload: OFF }))

    await h.sync.refresh('sign-in')

    expect(h.stored()).toEqual(CACHED_ON)
    expect(h.lines).toEqual(['[client-config] fetched v6 is not newer than cached v7; ignoring (sign-in)'])
  })

  it('sign-in does not wait', async () => {
    const h = harness(CACHED_ON, () => new Promise(() => undefined))

    await h.sync.settleBeforeSignInFinishes()

    expect(h.events).toEqual([])
  })

  it('a failed refresh only logs and keeps the cache', async () => {
    const h = harness(CACHED_ON, () => Promise.reject(new Error('offline')))

    await h.sync.refresh('boot')

    expect(h.stored()).toEqual(CACHED_ON)
    expect(h.lines).toEqual(['[client-config] fetch unavailable (offline); keeping cached state'])
  })
})

// Fork CI does not run the e2e lanes, so the order main actually runs is pinned from
// its source. Comments are stripped first: a comment naming the right order proves nothing.
describe('main.ts opens the first window in that order', () => {
  const stripped = fs
    .readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')

  const ready = stripped.slice(stripped.indexOf('app.whenReady().then('))
  const readyBody = ready.slice(0, ready.indexOf('\n})\n'))

  it('holds createWindow behind the settle, and is the only create before activate', () => {
    const settle = readyBody.indexOf('await clientConfigSync.settleBeforeFirstWindow()')
    const firstCreate = readyBody.indexOf('createWindow()')

    expect(settle).toBeGreaterThan(-1)
    expect(firstCreate).toBeGreaterThan(settle)
    expect(readyBody.startsWith('app.whenReady().then(async () => {')).toBe(true)

    // The boot refresh and everything after it stay behind the window, as they were.
    expect(readyBody.indexOf("void refreshClientConfigFromPlatform('boot')")).toBeGreaterThan(firstCreate)
    expect(readyBody.indexOf("app.on('activate'")).toBeGreaterThan(firstCreate)
  })

  it('nothing else can open the window during the hold', () => {
    const callers = [...stripped.matchAll(/(?<!function )\bcreateWindow\(\)/g)].map(match => stripped.slice(0, match.index).split('\n').length)
    expect(callers).toHaveLength(2)

    const secondInstance = stripped.slice(stripped.indexOf("app.on('second-instance'"))

    expect(secondInstance.slice(0, secondInstance.indexOf('\n  })\n'))).toMatch(
      /isReady: app\.isReady\(\) && !clientConfigSync\.holdingFirstWindow\(\)/
    )
  })

  it('settles this launch into the environment with the same rule as the launch-time read', () => {
    expect(stripped).toMatch(/applySwitches: payload => applyDesktopFeatureSwitches\(process\.env, payload, rememberLog\)/)
    expect(stripped).toMatch(/^applyDesktopFeatureSwitches\(process\.env, readClientConfigState\(\)\.payload\b/m)
  })

  it('sign-in settles before it commits the new key, so the login screen is still up', () => {
    const signIn = stripped.slice(stripped.indexOf('async function provisionManagedFromAccessToken('))
    const settle = signIn.indexOf('await clientConfigSync.settleBeforeSignInFinishes()')
    const commit = signIn.indexOf('await provisionManagedRelayForCurrentAccount(')
    const restart = signIn.indexOf('await finishManagedModelRuntime(target, current)')

    expect(settle).toBeGreaterThan(-1)
    expect(commit).toBeGreaterThan(settle)
    expect(restart).toBeGreaterThan(commit)
  })

  it('main and preload use one channel for a late config', () => {
    const preload = fs.readFileSync(path.join(import.meta.dirname, 'preload.ts'), 'utf8')

    expect(stripped).toMatch(/webContents\.send\('hermes:clientConfig:arrived', clientConfigForRenderer\(state, process\.env\)\)/)
    expect(preload).toMatch(/ipcRenderer\.on\('hermes:clientConfig:arrived', listener\)/)
  })

  it('the wait stays short enough to read as a launch', () => {
    expect(FIRST_LAUNCH_CONFIG_WAIT_MS).toBeLessThanOrEqual(3_000)
  })
})
