// The real core contributions: the folded ⌘K rows and the layout editor's ⌘⇧\ live here.
import '@/app/contrib/controller'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { paletteJson } from '@/__identity__/palette/render'
import { type KeybindRuntimeDeps, useKeybinds } from '@/app/hooks/use-keybinds'
import { $terminalTakeover, setTerminalTakeover } from '@/app/right-sidebar/store'
import { KeybindSettings } from '@/app/settings/keybind-settings'
import { $layoutEditMode } from '@/components/pane-shell/edit-mode'
import { findGroup, group, split } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { I18nProvider } from '@/i18n'
import { $hudActive } from '@/store/hud'
import { closeKeybindPanel, openKeybindPanel } from '@/store/keybinds'
import { $fileBrowserOpen, $panesFlipped, setFileBrowserOpen } from '@/store/layout'
import { openFolderAsProject } from '@/store/projects'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $statusbarVisible } from '@/store/statusbar-prefs'
import { titlebarAppActionsClusterCounts } from '@/store/titlebar-app-actions'
import { setToolViewMode } from '@/store/tool-view'

import { KeybindPanel } from './keybind-panel'
import { $productFold, titlebarClusterCounts } from './product-fold'

/**
 * hc-1085: single-thread product mode folds the titlebar's developer controls
 * (布局编辑器, HUD 模式, 交换侧边栏位置, 显示右侧栏) and ⌘K's developer
 * commands together with their shortcuts, ⌘K rows and shortcut-list lines,
 * keeps the way back while a saved layout is off the product default, and
 * leaves developer mode and the switch off alone. The buttons and the whole
 * palette are pinned by titlebar-identity.test.tsx and palette-identity.test.tsx.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

// ⌘O's native folder picker: only whether the shortcut reached it matters here.
vi.mock('@/store/projects', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  openFolderAsProject: vi.fn(async () => undefined)
}))

// The controller loads the bundled plugins; Bot Mode's clocks, sockets and sweeps stay out.
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

type Mode = 'developer' | 'product' | 'switch-off'

function setMode(mode: Mode): void {
  // Tool view first: switch-on-then-developer would pass through product mode on the way.
  setToolViewMode(mode === 'developer' ? 'technical' : 'product')
  setSingleThreadFlagForTest(mode !== 'switch-off')
}

const hudOpen = vi.fn(async () => ({ ok: true }))

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { hud: { close: vi.fn(), open: hudOpen } }
  })
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  Element.prototype.scrollIntoView ??= () => undefined
})

beforeEach(() => {
  // Sessions | chat | files over the terminal folded to its rail: a right side, and a terminal off it.
  $layoutTree.set(
    split('column', [
      split('row', [
        group(['sessions'], { id: 'grp-sessions' }),
        group(['workspace'], { id: 'grp-main' }),
        group(['files'], { id: 'grp-files' })
      ]),
      group(['terminal'], { id: 'grp-terminal', minimized: true })
    ])
  )
  setFileBrowserOpen(false)
  setTerminalTakeover(false)
  $statusbarVisible.set(true)
  $layoutEditMode.set(false)
  $hudActive.set(false)
  hudOpen.mockClear()
  vi.mocked(openFolderAsProject).mockClear()
})

afterEach(() => {
  cleanup()
  closeKeybindPanel()
  setMode('switch-off')
  setToolViewMode('product')
})

const NOTHING = {
  devCommands: false,
  flip: false,
  hud: false,
  layout: false,
  logs: false,
  rightEdge: false,
  statusbar: false,
  terminal: false
}

const PRODUCT = {
  devCommands: true,
  flip: true,
  hud: true,
  layout: true,
  logs: true,
  rightEdge: true,
  statusbar: true,
  terminal: true
}

describe('$productFold', () => {
  it.each([
    ['switch-off', {}, NOTHING],
    ['developer', {}, NOTHING],
    ['developer', { flipped: true, hiddenBar: true, rightOpen: true, terminal: true }, NOTHING],
    ['product', {}, PRODUCT],
    // The way back: swapped sides keep the swap and the right edge (it holds the sessions now).
    ['product', { flipped: true }, { ...PRODUCT, flip: false, rightEdge: false }],
    // An open right side keeps its button until it is closed.
    ['product', { rightOpen: true }, { ...PRODUCT, rightEdge: false }],
    // A hidden status bar keeps the toggle that shows it.
    ['product', { hiddenBar: true }, { ...PRODUCT, statusbar: false }],
    // A terminal on screen keeps the toggle that closes it.
    ['product', { terminal: true }, { ...PRODUCT, terminal: false }]
  ] as const)(
    '%s %j',
    (mode, state: { flipped?: boolean; hiddenBar?: boolean; rightOpen?: boolean; terminal?: boolean }, fold) => {
      setMode(mode)
      $panesFlipped.set(Boolean(state.flipped))
      setFileBrowserOpen(Boolean(state.rightOpen))
      $statusbarVisible.set(!state.hiddenBar)
      setTerminalTakeover(Boolean(state.terminal))

      expect($productFold.get()).toEqual(fold)
    }
  )

  it('a layout rewrite that changes no input keeps the same value (no re-render per sash frame)', () => {
    setMode('product')
    const before = $productFold.get()

    $layoutTree.set({ ...$layoutTree.get()! })

    expect($productFold.get()).toBe(before)
  })
})

describe('titlebarClusterCounts (the width the shell reserves)', () => {
  it.each(['left', 'right'] as const)('nothing folded: exactly the upstream counts (app actions %s)', side => {
    for (const leftExtras of [0, 2]) {
      expect(titlebarClusterCounts(side, leftExtras, $productFold.get())).toEqual(
        titlebarAppActionsClusterCounts(side, leftExtras, 0)
      )
    }
  })

  it.each([
    ['right', { left: 1, right: 1 }],
    ['left', { left: 2, right: 0 }]
  ] as const)('product mode keeps the sidebar button and 打开设置 only (app actions %s)', (side, counts) => {
    setMode('product')

    expect(titlebarClusterCounts(side, 0, $productFold.get())).toEqual(counts)
  })
})

function KeybindHarness() {
  const deps: KeybindRuntimeDeps = {
    archiveSelectedSession: vi.fn(),
    openNewSessionTab: vi.fn(),
    startFreshSession: vi.fn(),
    toggleCommandCenter: vi.fn(),
    toggleSelectedPin: vi.fn()
  }

  useKeybinds(deps)

  return null
}

function mountKeybinds(): void {
  render(
    <MemoryRouter initialEntries={['/chat-a']}>
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindHarness />
      </I18nProvider>
    </MemoryRouter>
  )
}

const press = {
  flip: () => fireEvent.keyDown(window, { code: 'Backslash', key: '\\', metaKey: true }),
  hud: () => fireEvent.keyDown(window, { code: 'KeyH', key: 'h', metaKey: true, shiftKey: true }),
  layoutEditor: () => fireEvent.keyDown(window, { code: 'Backslash', key: '\\', metaKey: true, shiftKey: true }),
  openFolder: () => fireEvent.keyDown(window, { code: 'KeyO', key: 'o', metaKey: true }),
  rightEdge: () => fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true }),
  statusbar: () => fireEvent.keyDown(window, { code: 'KeyS', key: 's', metaKey: true, shiftKey: true }),
  tabs: () => fireEvent.keyDown(window, { altKey: true, code: 'KeyT', key: 't', metaKey: true }),
  terminal: () => fireEvent.keyDown(window, { code: 'Backquote', ctrlKey: true, key: '`' })
}

const mainTabStrip = () => findGroup($layoutTree.get()!, 'grp-main')?.tabStrip

describe('the folded controls’ shortcuts', () => {
  it.each(['developer', 'switch-off'] as const)('%s: each shortcut does what it always did', mode => {
    setMode(mode)
    mountKeybinds()

    press.flip()
    expect($panesFlipped.get()).toBe(true)
    press.flip()

    press.rightEdge()
    expect($fileBrowserOpen.get()).toBe(true)

    press.hud()
    expect(hudOpen).toHaveBeenCalledTimes(1)

    press.layoutEditor()
    expect($layoutEditMode.get()).toBe(true)

    press.statusbar()
    expect($statusbarVisible.get()).toBe(false)

    press.tabs()
    expect(mainTabStrip()).toBeDefined()

    press.terminal()
    expect($terminalTakeover.get()).toBe(true)

    press.openFolder()
    expect(openFolderAsProject).toHaveBeenCalledTimes(1)
  })

  it('product mode: none of them does anything', () => {
    setMode('product')
    mountKeybinds()

    press.flip()
    press.rightEdge()
    press.hud()
    press.layoutEditor()
    press.statusbar()
    press.tabs()
    press.terminal()
    press.openFolder()

    expect($panesFlipped.get()).toBe(false)
    expect($fileBrowserOpen.get()).toBe(false)
    expect(hudOpen).not.toHaveBeenCalled()
    expect($layoutEditMode.get()).toBe(false)
    expect($statusbarVisible.get()).toBe(true)
    expect(mainTabStrip()).toBeUndefined()
    expect($terminalTakeover.get()).toBe(false)
    expect(openFolderAsProject).not.toHaveBeenCalled()
  })

  it('product mode with the status bar hidden: ⇧⌘S shows it, then is inert', () => {
    $statusbarVisible.set(false)
    setMode('product')
    mountKeybinds()

    press.statusbar()
    expect($statusbarVisible.get()).toBe(true)

    press.statusbar()
    expect($statusbarVisible.get()).toBe(true)
  })

  it('product mode with the terminal on screen: ⌃` closes it, then is inert', () => {
    setTerminalTakeover(true)
    setMode('product')
    mountKeybinds()

    press.terminal()
    expect($terminalTakeover.get()).toBe(false)

    press.terminal()
    expect($terminalTakeover.get()).toBe(false)
  })

  it('product mode with the sides swapped: ⌘\\ swaps them back, then is inert', () => {
    $panesFlipped.set(true)
    setMode('product')
    mountKeybinds()

    press.flip()
    expect($panesFlipped.get()).toBe(false)

    press.flip()
    expect($panesFlipped.get()).toBe(false)
  })

  it('product mode with the right side open: ⌘J closes it, then is inert', () => {
    setFileBrowserOpen(true)
    setMode('product')
    mountKeybinds()

    press.rightEdge()
    expect($fileBrowserOpen.get()).toBe(false)

    press.rightEdge()
    expect($fileBrowserOpen.get()).toBe(false)
  })
})

/** Every ⌘K row of the real palette, without its state and shortcut suffixes. */
async function paletteRows(): Promise<string[]> {
  const groups = JSON.parse(await paletteJson()) as { rows: string[] }[]

  return groups.flatMap(group => group.rows)
}

const has = (rows: string[], label: string) => rows.some(row => row.startsWith(label))

const FOLDED_ROWS = [
  'Toggle layout edit mode',
  'Reset layout',
  'Reload desktop plugins',
  'Toggle status bar',
  'Toggle tabs',
  'Export profile…',
  'Import profile…',
  'Toggle terminal',
  'Toggle logs',
  'Toggle Sessions tab',
  'Toggle yolo',
  'Open folder as project…',
  'Import session',
  '配置档案',
  '派生树',
  '技能与工具',
  '消息平台',
  '排程',
  '记忆图谱',
  '会话',
  '系统',
  '重启网关'
]

describe('⌘K', () => {
  it.each(['developer', 'switch-off'] as const)('%s: every developer row is there', async mode => {
    setMode(mode)
    const rows = await paletteRows()

    for (const label of FOLDED_ROWS) {
      expect(has(rows, label)).toBe(true)
    }
  })

  it('product mode: the developer rows leave; the product ones stay', async () => {
    setMode('product')
    const rows = await paletteRows()

    for (const label of FOLDED_ROWS) {
      expect(has(rows, label)).toBe(false)
    }

    for (const label of ['设置', '产物', 'Keyboard shortcuts', '用量', '检查 APEX 更新', '更改主题']) {
      expect(has(rows, label)).toBe(true)
    }
  })

  it('product mode keeps the way back: a hidden status bar, a terminal on screen', async () => {
    $statusbarVisible.set(false)
    setTerminalTakeover(true)
    setMode('product')
    const rows = await paletteRows()

    expect(has(rows, 'Toggle status bar')).toBe(true)
    expect(has(rows, 'Toggle terminal')).toBe(true)
    expect(has(rows, 'Toggle tabs')).toBe(false)
  })
})

const FOLDED_LABELS = [
  'Swap sidebar sides',
  'Toggle file browser',
  'Toggle HUD mode',
  'Toggle status bar',
  'Toggle tabs',
  'Toggle terminal',
  'New terminal',
  'Open folder as project',
  'Open profiles',
  'Open agents',
  'Open skills',
  'Open messaging',
  'Open scheduled jobs'
]

function renderShortcutLists(): string {
  openKeybindPanel()
  render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindPanel />
      </I18nProvider>
    </MemoryRouter>
  )

  const panel = screen.getByRole('dialog').textContent ?? ''
  cleanup()

  const settings = render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <KeybindSettings />
      </I18nProvider>
    </MemoryRouter>
  ).container.textContent

  return `${panel}\n---\n${settings}`
}

describe('the shortcut lists (⌘K 「Keyboard shortcuts」 and Settings › 快捷键)', () => {
  it.each(['developer', 'switch-off'] as const)('%s: list the folded controls’ shortcuts', mode => {
    setMode(mode)
    const [panel, settings] = renderShortcutLists().split('\n---\n')

    for (const label of FOLDED_LABELS) {
      expect(panel).toContain(label)
      expect(settings).toContain(label)
    }

    expect(settings).toContain('Toggle layout edit mode')
    expect(panel).toContain('Toggle sessions sidebar')
  })

  it('product mode: leave them out, keep the sidebar and settings ones', () => {
    setMode('product')
    const [panel, settings] = renderShortcutLists().split('\n---\n')

    for (const label of FOLDED_LABELS) {
      expect(panel).not.toContain(label)
      expect(settings).not.toContain(label)
    }

    expect(settings).not.toContain('Toggle layout edit mode')
    expect(panel).toContain('Toggle sessions sidebar')
    expect(settings).toContain('Toggle sessions sidebar')
  })
})
