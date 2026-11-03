// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import { $activeGatewayProfile } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { type MountedLayout, mountLayout, sidebarZoneHtml } from './__identity__/sidebar-zone/render'
import { seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1085 identity guard (hard rule 11) for the left column's tab strip.
 *
 * The goldens under `__identity__/sidebar-zone/` were recorded on fork main
 * aa8e554e38 with the same harness (render.tsx), before hc-1085 existed: the
 * zone holding the sessions pane after the real Bot Mode plugin registered and
 * the real tree adoption docked its pane there.
 *
 * - single_thread off, and developer mode (multi_bot on or off): the strip
 *   「会话 | 助手」 over the sidebar, byte-identical to main.
 * - product mode (multi_bot on or off): recorded on main with the same strip.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

// Bot Mode's clocks, sockets and sweeps: boundaries a rendered strip never reaches.
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
vi.mock('@/plugins/hermes-bots/data', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  migrateBotMeta: vi.fn(async () => undefined)
}))

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('CSS', { ...globalThis.CSS, escape: (value: string) => value })
})

afterAll(restoreRecordingTimeZone)

const GOLDEN = './__identity__/sidebar-zone'

const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'scripts', ui_meta: { apex: { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' } } }
]

let layout: MountedLayout | null = null

function boot(singleThread: boolean, toolView: 'product' | 'technical', multiBot: boolean): void {
  window.localStorage.clear()
  seedShellState()
  setSingleThreadFlagForTest(singleThread)
  setToolViewMode(toolView)
  setMultiBotFlagForTest(multiBot)
  resetBotRosterForTest(multiBot ? botRosterFrom(ROSTER_ROWS, () => true) : undefined)
  layout = mountLayout()
}

afterEach(() => {
  cleanup()
  layout?.dispose()
  layout = null
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  $activeGatewayProfile.set('default')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe.each([
  ['single_thread off', 'switch-off', false, 'product', false],
  ['developer mode, multi_bot off', 'developer', true, 'technical', false],
  ['developer mode, multi_bot on', 'developer-multi-bot', true, 'technical', true],
  ['product mode, multi_bot off', 'product', true, 'product', false],
  ['product mode, multi_bot on', 'product-multi-bot', true, 'product', true]
] as const)('%s: the left column', (_label, name, singleThread, toolView, multiBot) => {
  beforeEach(() => boot(singleThread, toolView, multiBot))

  it('the zone holding the sessions pane', async () => {
    await expect(await sidebarZoneHtml()).toMatchFileSnapshot(`${GOLDEN}/${name}.html`)
  })
})
