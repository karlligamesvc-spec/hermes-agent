// The real core contributions: the layout editor's ⌘⇧\ and its two ⌘K rows live here.
import '@/app/contrib/controller'

import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePaletteContributions } from '@/app/command-palette/contrib'
import { type KeybindRuntimeDeps, useKeybinds } from '@/app/hooks/use-keybinds'
import { KeybindSettings } from '@/app/settings/keybind-settings'
import { $layoutEditMode } from '@/components/pane-shell/edit-mode'
import { group, split } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { I18nProvider } from '@/i18n'
import { $hudActive } from '@/store/hud'
import { closeKeybindPanel, openKeybindPanel } from '@/store/keybinds'
import { $fileBrowserOpen, $panesFlipped, setFileBrowserOpen } from '@/store/layout'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { titlebarAppActionsClusterCounts } from '@/store/titlebar-app-actions'
import { setToolViewMode } from '@/store/tool-view'

import { KeybindPanel } from './keybind-panel'
import { $titlebarFold, productPaletteGroups, titlebarClusterCounts } from './product-titlebar'

/**
 * hc-1085: single-thread product mode folds the titlebar's developer controls
 * (布局编辑器, HUD 模式, 交换侧边栏位置, 显示右侧栏) together with their
 * shortcuts, ⌘K rows and shortcut-list lines, keeps the way back while a saved
 * layout is off the product default, and leaves developer mode and the switch
 * off alone. The buttons themselves are pinned by titlebar-identity.test.tsx.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

// useKeybinds only needs resolvedMode/setMode from the theme (as in find-bar.test.tsx).
vi.mock('@/themes/context', () => ({
  useTheme: () => ({ resolvedMode: 'dark', setMode: vi.fn() })
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
  setSingleThreadFlagForTest(mode !== 'switch-off')
  setToolViewMode(mode === 'developer' ? 'technical' : 'product')
}

const hudOpen = vi.fn(async () => ({ ok: true }))

beforeAll(() => {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { hud: { close: vi.fn(), open: hudOpen } }
  })
})

beforeEach(() => {
  // Sessions | chat | files: a layout with a right side, the default's shape.
  $layoutTree.set(
    split('row', [
      group(['sessions'], { id: 'grp-sessions' }),
      group(['workspace'], { id: 'grp-main' }),
      group(['files'], { id: 'grp-files' })
    ])
  )
  setFileBrowserOpen(false)
  $layoutEditMode.set(false)
  $hudActive.set(false)
  hudOpen.mockClear()
})

afterEach(() => {
  cleanup()
  closeKeybindPanel()
  setMode('switch-off')
  setToolViewMode('product')
})

describe('$titlebarFold', () => {
  it.each([
    ['switch-off', false, false, { flip: false, hud: false, layout: false, rightEdge: false }],
    ['developer', false, false, { flip: false, hud: false, layout: false, rightEdge: false }],
    ['developer', true, true, { flip: false, hud: false, layout: false, rightEdge: false }],
    ['product', false, false, { flip: true, hud: true, layout: true, rightEdge: true }],
    // The way back: swapped sides keep the swap and the right edge (it holds the sessions now).
    ['product', true, false, { flip: false, hud: true, layout: true, rightEdge: false }],
    // An open right side keeps its button until it is closed.
    ['product', false, true, { flip: true, hud: true, layout: true, rightEdge: false }]
  ] as const)('%s, sessions on the right %s, right side open %s', (mode, flipped, rightOpen, fold) => {
    setMode(mode)
    $panesFlipped.set(flipped)
    setFileBrowserOpen(rightOpen)

    expect($titlebarFold.get()).toEqual(fold)
  })
})

describe('titlebarClusterCounts (the width the shell reserves)', () => {
  it.each(['left', 'right'] as const)('nothing folded: exactly the upstream counts (app actions %s)', side => {
    for (const leftExtras of [0, 2]) {
      expect(titlebarClusterCounts(side, leftExtras, $titlebarFold.get())).toEqual(
        titlebarAppActionsClusterCounts(side, leftExtras, 0)
      )
    }
  })

  it.each([
    ['right', { left: 1, right: 1 }],
    ['left', { left: 2, right: 0 }]
  ] as const)('product mode keeps the sidebar button and 打开设置 only (app actions %s)', (side, counts) => {
    setMode('product')

    expect(titlebarClusterCounts(side, 0, $titlebarFold.get())).toEqual(counts)
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
  rightEdge: () => fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true })
}

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
  })

  it('product mode: none of them does anything', () => {
    setMode('product')
    mountKeybinds()

    press.flip()
    press.rightEdge()
    press.hud()
    press.layoutEditor()

    expect($panesFlipped.get()).toBe(false)
    expect($fileBrowserOpen.get()).toBe(false)
    expect(hudOpen).not.toHaveBeenCalled()
    expect($layoutEditMode.get()).toBe(false)
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

/** The ⌘K 「Commands」 group as the palette builds it from the real registrations. */
function commandRows() {
  const { result } = renderHook(() => usePaletteContributions())

  return [{ items: result.current.map(item => ({ action: item.action, id: item.key, label: item.label })) }]
}

describe('the layout editor’s ⌘K rows', () => {
  it.each(['developer', 'switch-off'] as const)('%s: the palette shows them, groups untouched', mode => {
    setMode(mode)
    const groups = commandRows()
    const labels = groups[0].items.map(item => item.label)

    expect(labels).toEqual(expect.arrayContaining(['Toggle layout edit mode', 'Reset layout']))
    expect(productPaletteGroups(groups)).toBe(groups)
  })

  it('product mode: both rows leave, every other row stays', () => {
    setMode('product')
    const groups = commandRows()
    const shown = productPaletteGroups(groups)[0].items.map(item => item.label)

    expect(shown).not.toContain('Toggle layout edit mode')
    expect(shown).not.toContain('Reset layout')
    expect(shown).toEqual(
      groups[0].items
        .map(item => item.label)
        .filter(label => label !== 'Toggle layout edit mode' && label !== 'Reset layout')
    )
  })
})

describe('productPaletteGroups keeps hc-1014’s rule', () => {
  it('product mode still drops the rows that start a second conversation', () => {
    setMode('product')

    const groups = [
      {
        heading: 'Go to',
        items: [
          { action: 'session.new', id: 'new' },
          { action: 'nav.settings', id: 'settings' }
        ]
      }
    ]

    expect(productPaletteGroups(groups)).toEqual([
      { heading: 'Go to', items: [{ action: 'nav.settings', id: 'settings' }] }
    ])
  })
})

const FOLDED_LABELS = ['Swap sidebar sides', 'Toggle file browser', 'Toggle HUD mode']

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
  it.each(['developer', 'switch-off'] as const)('%s: list the four shortcuts', mode => {
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
