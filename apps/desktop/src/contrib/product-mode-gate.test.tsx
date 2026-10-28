// First, before any app module: the harness's recording time zone (it renders the sidebar's dates).
import '@/__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BOOT_TREE, type MountedLayout, mountLayout, sidebarZoneHtml } from '@/__identity__/sidebar-zone/render'
import { seedShellState } from '@/__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { PALETTE_AREA } from '@/app/command-palette/contrib'
import { findGroupOfPane, group, split } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { $workspaceMode, setWorkspaceScope } from '@/components/pane-shell/workspace-scope'
import { $botsPaneVisible } from '@/plugins/hermes-bots/bot-state'
import { host } from '@/sdk'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { createPluginContext } from './plugin'
import { pluginPaneVisibility, PRODUCT_MODE_HIDDEN, registerPluginContributions } from './product-mode-gate'
import { $registryVersion, registry } from './registry'
import type { Contribution } from './types'

/**
 * hc-1085: single-thread product mode leaves Bot Mode's 「助手」 pane (and the
 * ⌘K row that only points at it) out of the registry, and Bot Mode never sees
 * that pane as on screen. Developer mode and the switch off are untouched, and
 * nothing the user saved moves.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

// Bot Mode's clocks, sockets and sweeps (same list as sidebar-zone-identity.test.tsx).
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

const BOTS_PANE = 'hermes-bots:pane'
const NEW_AGENT_ROW = 'hermes-bots:new-agent'
const LAYOUT_KEY = 'hermes.desktop.layoutTree.v2'

function productMode(): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
}

function developerMode(): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('technical')
}

const registered = (area: string, id: string) => registry.getArea(area).some(c => c.id === id)

const disposers: (() => void)[] = []
let layout: MountedLayout | null = null

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  layout?.dispose()
  layout = null
  disposers.splice(0).forEach(dispose => dispose())
  setWorkspaceScope('sessions')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  vi.useRealTimers()
})

const contribution = (id: string, area = 'panes'): Contribution => ({ area, id, render: () => null })

describe('registerPluginContributions', () => {
  it('a batch with nothing held back is one registry batch, as before', () => {
    productMode()
    const before = $registryVersion.get()

    disposers.push(registerPluginContributions([contribution('demo:a'), contribution('demo:b', 'statusBar.left')]))

    expect($registryVersion.get()).toBe(before + 1)
    expect(registered('panes', 'demo:a')).toBe(true)
    expect(registered('statusBar.left', 'demo:b')).toBe(true)
  })

  it('holds the 「助手」 pane back in product mode and registers it the moment developer mode turns on', () => {
    productMode()
    disposers.push(registerPluginContributions([contribution(BOTS_PANE)]))

    expect(registered('panes', BOTS_PANE)).toBe(false)

    developerMode()
    expect(registered('panes', BOTS_PANE)).toBe(true)

    productMode()
    expect(registered('panes', BOTS_PANE)).toBe(false)

    setSingleThreadFlagForTest(false)
    expect(registered('panes', BOTS_PANE)).toBe(true)
  })

  it('splits a mixed batch: the rest registers in product mode, the held one waits', () => {
    productMode()
    disposers.push(registerPluginContributions([contribution('demo:a'), contribution(NEW_AGENT_ROW, PALETTE_AREA)]))

    expect(registered('panes', 'demo:a')).toBe(true)
    expect(registered(PALETTE_AREA, NEW_AGENT_ROW)).toBe(false)
  })

  it('its disposer removes the contribution and stops following the mode', () => {
    developerMode()
    const dispose = registerPluginContributions([contribution(BOTS_PANE)])

    expect(registered('panes', BOTS_PANE)).toBe(true)

    dispose()
    expect(registered('panes', BOTS_PANE)).toBe(false)

    productMode()
    developerMode()
    expect(registered('panes', BOTS_PANE)).toBe(false)
  })
})

describe('a plugin context', () => {
  it.each(['register', 'registerMany'] as const)('%s goes through the gate', method => {
    productMode()
    const ctx = createPluginContext('hermes-bots', dispose => disposers.push(dispose))
    const pane = { area: 'panes', id: 'pane', render: () => null }

    if (method === 'register') {
      ctx.register(pane)
    } else {
      ctx.registerMany([pane])
    }

    expect(registered('panes', BOTS_PANE)).toBe(false)

    developerMode()
    expect(registered('panes', BOTS_PANE)).toBe(true)
  })
})

describe('pluginPaneVisibility', () => {
  it('any other pane gets the tree store itself back', () => {
    const $onScreen = atom(true)

    expect(pluginPaneVisibility('hermes-bots:routines', $onScreen)).toBe($onScreen)
  })

  it('the held-back pane reads false in product mode however the tree answers', () => {
    const $onScreen = atom(true)
    const $visible = pluginPaneVisibility(BOTS_PANE, $onScreen)

    productMode()
    expect($visible.get()).toBe(false)

    developerMode()
    expect($visible.get()).toBe(true)

    $onScreen.set(false)
    expect($visible.get()).toBe(false)
  })
})

/** The default layout after the user clicked 「助手」 (0.17.66 product mode did let them). */
const BOTS_ACTIVE_TREE = split(
  'row',
  [group(['sessions', BOTS_PANE], { active: BOTS_PANE, id: 'grp-sessions' }), group(['workspace'], { id: 'grp-main' })],
  [1, 4.6]
)

const tabIds = (html: string) => [...html.matchAll(/data-tree-tab="([^"]+)"/g)].map(match => match[1])

describe('the real Bot Mode plugin', () => {
  beforeEach(() => {
    seedShellState()
  })

  it('registers every held-back id in developer mode, so the list cannot go stale', () => {
    developerMode()
    layout = mountLayout()

    expect(registered('panes', BOTS_PANE)).toBe(true)
    expect(registered(PALETTE_AREA, NEW_AGENT_ROW)).toBe(true)
    expect([...PRODUCT_MODE_HIDDEN].sort()).toEqual([BOTS_PANE, NEW_AGENT_ROW].sort())
  })

  it('product mode: no 「助手」 pane, no 「添加助手」 row; its other contributions stay', async () => {
    productMode()
    layout = mountLayout()

    expect(registered('panes', BOTS_PANE)).toBe(false)
    expect(registered(PALETTE_AREA, NEW_AGENT_ROW)).toBe(false)
    expect(registry.getArea('composer.atCompletions').some(c => c.id === 'hermes-bots:mention-completions')).toBe(true)
    expect(findGroupOfPane($layoutTree.get()!, BOTS_PANE)).toBeNull()

    const html = await sidebarZoneHtml()

    expect(html).not.toContain('role="tablist"')
    expect(tabIds(html)).toEqual([])
  })

  it('product mode over a saved layout with 「助手」 active: the sidebar shows, Bot Mode stands down, nothing saved moves', async () => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(BOTS_ACTIVE_TREE))
    productMode()
    layout = mountLayout(BOTS_ACTIVE_TREE)

    const html = await sidebarZoneHtml()

    expect(html).not.toContain('role="tablist"')
    expect(html).toContain('data-single-thread-nav')
    expect(host.paneVisibility(BOTS_PANE).get()).toBe(false)
    expect($botsPaneVisible.get()).toBe(false)
    // Bot Mode seats its Scheduled jobs tile only while it owns the workspace.
    expect(registered('panes', 'hermes-bots:routines')).toBe(false)
    expect($workspaceMode.get()).toBe('sessions')
    expect($layoutTree.get()).toEqual(BOTS_ACTIVE_TREE)
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify(BOTS_ACTIVE_TREE))
  })

  it('developer → product → developer with 「助手」 active comes back exactly as it was', async () => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(BOTS_ACTIVE_TREE))
    developerMode()
    layout = mountLayout(BOTS_ACTIVE_TREE)

    const saved = window.localStorage.getItem(LAYOUT_KEY)
    const tree = $layoutTree.get()

    expect(tabIds(await sidebarZoneHtml())).toEqual(['sessions', BOTS_PANE])
    expect(host.paneVisibility(BOTS_PANE).get()).toBe(true)
    cleanup()

    productMode()
    expect(tabIds(await sidebarZoneHtml())).toEqual([])
    expect($botsPaneVisible.get()).toBe(false)
    expect($workspaceMode.get()).toBe('sessions')
    cleanup()

    developerMode()
    const back = await sidebarZoneHtml()

    expect(tabIds(back)).toEqual(['sessions', BOTS_PANE])
    expect(back).toMatch(/data-active="true"[^>]*data-tree-tab="hermes-bots:pane"/)
    expect($botsPaneVisible.get()).toBe(true)
    expect($layoutTree.get()).toEqual(tree)
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe(saved)
  })

  it('booted in product mode, the pane joins the sessions strip once developer mode turns on', async () => {
    productMode()
    layout = mountLayout(BOOT_TREE)

    expect(findGroupOfPane($layoutTree.get()!, BOTS_PANE)).toBeNull()

    developerMode()

    expect(findGroupOfPane($layoutTree.get()!, BOTS_PANE)?.id).toBe('grp-sessions')
    expect(tabIds(await sidebarZoneHtml())).toEqual(['sessions', BOTS_PANE])
  })
})
