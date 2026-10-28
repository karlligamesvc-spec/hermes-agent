// The real core contributions and bundled plugins the palette lists.
import '@/app/contrib/controller'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { paletteJson } from './__identity__/palette/render'

/**
 * hc-1085 identity guard (hard rule 11) for the command palette (⌘K).
 *
 * The goldens under `__identity__/palette/` were recorded on fork main
 * aa8e554e38 with the same harness (render.tsx), before hc-1085 folded any
 * row: every group and row with single_thread off, in developer mode and in
 * product mode.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

// Bot Mode's clocks, sockets and sweeps (the controller loads the bundled plugins).
vi.mock('@/plugins/hermes-bots/avatar', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  startFaceClock: vi.fn(),
  stopFaceClock: vi.fn()
}))
vi.mock('@/plugins/hermes-bots/relay', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  startBotRelay: vi.fn(),
  stopBotRelay: vi.fn()
}))
vi.mock('@/plugins/hermes-bots/session-sweep', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  startHideSweepScheduler: vi.fn()
}))
vi.mock('@/plugins/hermes-bots/group-chat', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  pullGroupChatServerState: vi.fn(async () => false),
  scheduleGroupChatServerSync: vi.fn(),
  stopGroupChatServerSync: vi.fn()
}))

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  Element.prototype.scrollIntoView ??= () => undefined
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

const GOLDEN = './__identity__/palette'

describe.each([
  ['switch-off', false, 'product'],
  ['developer', true, 'technical'],
  ['product', true, 'product']
] as const)('%s: the command palette', (name, singleThread, toolView) => {
  it('every group and row', async () => {
    // Tool view first: switch-on-then-developer would pass through product mode on the way.
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)

    await expect(await paletteJson()).toMatchFileSnapshot(`${GOLDEN}/${name}.json`)
  })
})
