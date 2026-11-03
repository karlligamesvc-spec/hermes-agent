/**
 * hc-1086: the same identity traces as multi-bot-handoff-identity.test.tsx, with
 * `localStorage` the plain in-memory object vitest.setup.ts installs on Node 26
 * (CI) instead of jsdom's Storage (Node 24 and earlier). The storage column must
 * read the same in both, so a local run covers what CI sees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { resetHandoffsForTest, setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import { traceJson, traceShell } from './__identity__/multi-bot-handoff/trace'

// Before any app module reads it: vitest.setup.ts's Node 26 shape, whatever Node runs this.
vi.hoisted(() => {
  const store = new Map<string, string>()

  const storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(String(key)) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(String(key)),
    setItem: (key: string, value: string) => void store.set(String(key), String(value))
  }

  for (const target of [globalThis, (globalThis as { window?: unknown }).window].filter(Boolean)) {
    Object.defineProperty(target, 'localStorage', { configurable: true, value: storage, writable: true })
  }
})

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined)
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

const GOLDEN = './__identity__/multi-bot-handoff'

beforeEach(() => {
  localStorage.clear()
  resetMainThreadForTest()
  resetBotRosterForTest()
  $gatewayState.set('open')
  $activeGatewayProfile.set('default')
  setSingleThreadFlagForTest(true)
})

afterEach(() => {
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  resetBotRosterForTest()
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $gatewayState.set('idle')
  localStorage.clear()
})

describe.each([
  ['one assistant', 'one-assistant', false, false],
  ['several assistants, product mode', 'several-product', true, false],
  ['several assistants, product mode, relay switch on (idle)', 'several-product', true, true]
] as const)('plain-object localStorage (Node 26), %s: the same trace', (_label, name, multiBot, relay) => {
  it('engine requests and storage writes over two roster refreshes', async () => {
    expect(window.localStorage instanceof Storage).toBe(false)
    setToolViewMode('product')
    setMultiBotFlagForTest(multiBot)
    setMultiBotHandoffFlagForTest(relay)
    resetHandoffsForTest()
    localStorage.clear()

    await expect(traceJson(await traceShell(2))).toMatchFileSnapshot(`${GOLDEN}/shell-${name}.json`)
  })
})
