// The real core contributions and bundled plugins the palette lists.
import '@/app/contrib/controller'

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { HelpHint } from '@/app/chat/composer/help-hint'
import { CommandPalette } from '@/app/command-palette'
import { type KeybindRuntimeDeps, useKeybinds } from '@/app/hooks/use-keybinds'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { en } from '@/i18n/en'
import { queryClient } from '@/lib/query-client'
import { $authState } from '@/store/auth'
import {
  $commandPaletteSeed,
  closeCommandPalette,
  openCommandPalette,
  openCommandPalettePage
} from '@/store/command-palette'
import { $notifications, clearNotifications, notifyError } from '@/store/notifications'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

/**
 * hc-1109: every way product mode could still reach a folded Settings page.
 *
 * The overlay itself only knows the kept tabs (product-settings.test.tsx); this
 * file covers the doors product mode still shows: every ⌘K row a search or the
 * settings page lists, ⌘/, the composer's 「?」 list, the pool-slot error, and a
 * census of every literal `?tab=` exit in the renderer.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getEnvVars: vi.fn(async () => ({
    HTTPS_PROXY: { category: 'setting', description: 'Outbound proxy', is_set: false, redacted_value: null },
    TAVILY_API_KEY: { category: 'tool', description: 'Tavily web search', is_set: true, redacted_value: 'tvly…abcd' }
  })),
  getHermesConfigRecord: vi.fn(async () => ({
    agent: { max_turns: 60 },
    approvals: { mode: 'smart' },
    compression: { enabled: true },
    display: { personality: 'concise', show_reasoning: true },
    memory: { memory_enabled: true },
    model_context_length: 0,
    terminal: { cwd: '.' },
    timezone: '',
    tts: { provider: 'edge' }
  })),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => []),
  listAllProfileSessions: vi.fn(async (_limit: number, _offset: number, archived: string) => ({
    sessions:
      archived === 'only'
        ? [{ git_branch: null, id: 's-archived', preview: '上周的旧对话', title: '上周的旧对话' }]
        : []
  }))
}))

// Developer mode lists Open folder as project, which asks main for a folder.
vi.mock('@/store/projects', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  openFolderAsProject: vi.fn(async () => undefined)
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

type Mode = 'developer' | 'product' | 'switch-off'
type Account = 'apex' | 'own-key' | 'tier'

const signedOut = $authState.get()

function setMode(mode: Mode): void {
  // Tool view first: switch-on-then-developer would pass through product mode on the way.
  setToolViewMode(mode === 'developer' ? 'technical' : 'product')
  setSingleThreadFlagForTest(mode !== 'switch-off')
}

function setAccount(account: Account): void {
  $authState.set({
    ...signedOut,
    account: { email: 'creator@example.com', name: '' } as never,
    accountId: account === 'own-key' ? null : 'acct-1',
    enabled: account !== 'own-key',
    modelTiers: account === 'tier',
    status: account === 'own-key' ? 'disabled' : 'signed-in'
  })
}

afterEach(() => {
  cleanup()
  act(() => closeCommandPalette())
  clearNotifications()
  setMode('switch-off')
  $authState.set(signedOut)
  setRuntimeI18nLocale('en')
})

let location = ''

function LocationProbe() {
  const current = useLocation()
  location = `${current.pathname}${current.search}`

  return null
}

// Written out here rather than read from product-settings.ts: the check must not reuse what it checks.
const KEPT: Record<Account, readonly string[]> = {
  apex: ['config:personalization', 'config:memory', 'config:voice', 'notifications', 'config:appearance', 'about'],
  'own-key': [
    'config:personalization',
    'config:memory',
    'config:voice',
    'notifications',
    'config:appearance',
    'about',
    'config:model',
    'providers'
  ],
  tier: ['config:personalization', 'config:memory', 'config:voice', 'notifications', 'config:appearance', 'about']
}

/** The settings tab a location opens, `null` when it is not Settings; a field search target keeps its field. */
function settingsTabOf(path: string): null | { field: boolean; tab: string } {
  const url = new URL(path, 'https://apex.invalid')

  if (url.pathname !== '/settings') {
    return null
  }

  return { field: url.searchParams.has('field'), tab: url.searchParams.get('tab') ?? 'config:personalization' }
}

const ROOT_SEEDS = ['', 'key', '记忆', '网关', '时区', '归档', '旧对话', '语音', '快捷键', '设置', '高级', 'memory']
const SETTINGS_PAGE_SEEDS = ['', 'key', '记忆', '时区', '高级', '提供方']

async function openPalette(page: null | string, seed: string): Promise<HTMLElement[]> {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/chat-a']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <CommandPalette />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  act(() => {
    if (page) {
      openCommandPalettePage(page, seed || undefined)
    } else {
      $commandPaletteSeed.set(seed || null)
      openCommandPalette()
    }
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 120))
  })

  return [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
}

/** Select every row ⌘K lists for each seed, one per fresh palette, and say where each one went. */
async function everyRowsLanding(): Promise<{ label: string; to: string }[]> {
  const landings: { label: string; to: string }[] = []

  for (const [page, seeds] of [
    [null, ROOT_SEEDS],
    ['settings', SETTINGS_PAGE_SEEDS]
  ] as const) {
    for (const seed of seeds) {
      const count = (await openPalette(page, seed)).length
      act(() => closeCommandPalette())
      cleanup()

      for (let index = 0; index < count; index++) {
        const row = (await openPalette(page, seed))[index]
        location = '/chat-a'
        act(() => fireEvent.click(row))
        landings.push({ label: (row.textContent ?? '').trim(), to: location })
        act(() => closeCommandPalette())
        cleanup()
      }
    }
  }

  return landings
}

describe('⌘K: every row the product palette lists', () => {
  it.each(['tier', 'apex', 'own-key'] as const)(
    '%s: opens no folded Settings page',
    async account => {
      setAccount(account)
      setMode('product')

      const landings = await everyRowsLanding()
      const intoSettings = landings.filter(landing => settingsTabOf(landing.to))

      // The check can see a landing at all: 个性化, 外观, 记忆 and 语音 rows are there.
      expect(intoSettings.length).toBeGreaterThanOrEqual(4)

      for (const landing of intoSettings) {
        const target = settingsTabOf(landing.to)!
        const base = target.tab.split('&')[0]

        expect(KEPT[account], `${landing.label} → ${landing.to}`).toContain(base)
        // 记忆 is the ledger in product mode: no row may point at one of the engine's memory fields.
        expect(target.field && base === 'config:memory', `${landing.label} → ${landing.to}`).toBe(false)
      }
    },
    120_000
  )

  it('developer mode: the same searches reach the folded pages (so the check above can see them)', async () => {
    setAccount('tier')
    setMode('developer')

    const tabs = new Set(
      (await everyRowsLanding())
        .map(landing => settingsTabOf(landing.to)?.tab.split('&')[0])
        .filter((tab): tab is string => Boolean(tab))
    )

    // Keyboard shortcuts reaches 键盘快捷键 through an event the shell listens for (the ⌘/ case below).
    for (const tab of ['gateway', 'keys', 'sessions', 'config:advanced', 'config:chat', 'config:workspace']) {
      expect(tabs).toContain(tab)
    }
  }, 120_000)
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

describe('⌘/ (keybinds.openPanel) opens Settings › 键盘快捷键', () => {
  it.each([
    ['switch-off', '/settings?tab=keybinds'],
    ['developer', '/settings?tab=keybinds'],
    ['product', '/chat-a']
  ] as const)('%s → %s', (mode, landing) => {
    setMode(mode)
    render(
      <MemoryRouter initialEntries={['/chat-a']}>
        <I18nProvider configClient={null} initialLocale="en">
          <KeybindHarness />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.keyDown(window, { code: 'Slash', key: '/', metaKey: true })

    expect(location).toBe(landing)
  })
})

describe('the composer’s 「?」 list', () => {
  it.each([
    ['switch-off', true],
    ['developer', true],
    ['product', false]
  ] as const)('%s: lists ⌘/ → %s', (mode, listed) => {
    setMode(mode)
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <HelpHint />
      </I18nProvider>
    )

    expect(Boolean(screen.queryByText(en.composer.hotkeyDescs['keybinds.openPanel']))).toBe(listed)
  })
})

describe('the pool-slot error', () => {
  const slotTimeout = new Error('Local backend start for "apex-bot-2" timed out while waiting for a free slot.')

  it.each([
    ['switch-off', true],
    ['developer', true],
    ['product', false]
  ] as const)('%s: offers 打开高级设置 → %s', (mode, offered) => {
    setMode(mode)
    notifyError(slotTimeout, 'Could not open the assistant')

    const [notice] = $notifications.get()

    expect(notice.message).toBe(en.desktop.poolSlotTimeoutBody)
    expect(Boolean(notice.action)).toBe(offered)
  })
})

/**
 * Census (hard rule 12): every literal `?tab=` into Settings the renderer
 * writes, and where it leads in product mode. A new one fails here until it is
 * placed. Whatever the list says, the overlay lands an unkept tab on 个性化.
 */
const EXITS: Record<string, string> = {
  'app/business-workspace/components/daily-ideas.tsx → config:personalization': 'kept',
  'app/chat/composer/voice-conversation-panel.tsx → config:voice': 'kept',
  'app/chat/sidebar/profile-switcher.tsx → gateway':
    'the session sidebar’s profile menu; product mode shows the single-thread sidebar',
  'app/command-palette/index.tsx → ': '⌘K section rows (settingsTab): folded with their section',
  'app/command-palette/index.tsx → config:': '⌘K field rows: folded with their section (and 记忆’s fields)',
  'app/command-palette/index.tsx → sessions': '⌘K archived chats: folded',
  'app/contrib/wiring-routing.ts → config:advanced': 'the pool-slot error’s button: not offered in product mode',
  'app/contrib/wiring.tsx → billing': 'consumer-hidden in every mode',
  'app/contrib/wiring.tsx → keybinds': '⌘K Keyboard shortcuts: folded',
  'app/contrib/wiring.tsx → providers':
    'the model picker’s 管理提供方: the picker shows only on the user’s own key, which keeps 提供方',
  'app/desktop-controller.tsx → providers': 'DesktopController is not mounted',
  'app/hooks/use-keybinds.ts → keybinds': '⌘/: inert in product mode',
  'app/pet-generate/pet-generate-content.tsx → providers':
    'pet generation’s setup card: lands on 个性化 for an APEX account (follow-up)',
  'app/settings/model-tier-settings.tsx → providers': 'inside 档位, itself folded',
  'app/settings/plugin-install-modal.tsx → keys': 'Capabilities › Plugins, whose doors hc-1085 folded',
  'app/settings/plugin-install-modal.tsx → plugins': 'a moved tab: redirects to Capabilities',
  'app/settings/toolset-config-panel.tsx → keys': 'Capabilities › Toolsets, whose doors hc-1085 folded',
  'app/shell/hooks/use-statusbar-items.tsx → connections':
    'the status bar’s connection switcher; product mode’s bar drops it',
  'app/skills/index.tsx → config:model': 'Capabilities › vision, whose doors hc-1085 folded',
  'components/assistant-ui/thread/assistant-message.tsx → config:model':
    '切换提供方 on an error: hidden where nobody picks a model (hc-1015); the user’s own key keeps 模型',
  'components/onboarding/index.tsx → providers': 'local models, behind the --local launch flag',
  'components/tips/use-tip-rotation.ts → providers': 'local models, behind the --local launch flag'
}

const SRC = join(__dirname)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      return name === '__identity__' || name === 'node_modules' ? [] : sourceFiles(path)
    }

    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('census: every literal ?tab= into Settings', () => {
  it('is placed', () => {
    const found = new Set<string>()

    for (const file of sourceFiles(SRC)) {
      const source = withoutComments(readFileSync(file, 'utf8'))
      const name = relative(SRC, file)

      for (const match of source.matchAll(/(?:SETTINGS_ROUTE\}|['"`]#?\/settings)\?tab=([\w:.-]*)/g)) {
        found.add(`${name} → ${match[1]}`)
      }

      for (const match of source.matchAll(/\.set\('tab', '([^']+)'\)/g)) {
        found.add(`${name} → ${match[1]}`)
      }
    }

    expect([...found].sort()).toEqual(Object.keys(EXITS).sort())
  })
})
