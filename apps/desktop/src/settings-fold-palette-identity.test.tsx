// The real core contributions and bundled plugins the palette lists.
import '@/app/contrib/controller'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { CommandPalette } from '@/app/command-palette'
import { $authState } from '@/store/auth'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { ACCOUNT_KINDS, paletteGroups, seedAccount } from './__identity__/settings-fold/harness'

/**
 * hc-1109 identity guard (hard rule 11) for the ways ⌘K reaches Settings: the
 * settings page (⌘K on the Settings overlay, or its search pill) and the
 * searches that list sections, fields, keys and archived chats.
 *
 * Recorded on fork main 91b2f71eaf with the same harness, before hc-1109
 * folded any section, in the three modes for the three account kinds. The
 * root palette with nothing typed is hc-1085's guard (palette-identity).
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
    browser: { use_real_profile: false },
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

const signedOut = $authState.get()

afterEach(() => {
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $authState.set(signedOut)
})

const GOLDEN = './__identity__/settings-fold'

/** What gets typed: section names, a field, a key, an archived chat, the shortcuts. */
const ROOT_SEEDS = ['key', '记忆', '网关', '时区', '归档', '旧对话', '语音', '快捷键', '设置']
const SETTINGS_PAGE_SEEDS = ['', 'key', '记忆', '时区', '高级']

describe.each([
  ['switch-off', false, 'product'],
  ['developer', true, 'technical'],
  ['product', true, 'product']
] as const)('%s: ⌘K into Settings', (mode, singleThread, toolView) => {
  it.each(ACCOUNT_KINDS)('%s', async account => {
    seedAccount(account)
    // Tool view first: switch-on-then-developer would pass through product mode on the way.
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)

    const rows: Record<string, unknown> = {}

    for (const seed of ROOT_SEEDS) {
      rows[`root: ${seed}`] = await paletteGroups(<CommandPalette />, { seed })
    }

    for (const seed of SETTINGS_PAGE_SEEDS) {
      rows[`settings page: ${seed}`] = await paletteGroups(<CommandPalette />, { page: 'settings', seed })
    }

    await expect(JSON.stringify(rows, null, 2) + '\n').toMatchFileSnapshot(`${GOLDEN}/palette-${mode}-${account}.json`)
  })
})
