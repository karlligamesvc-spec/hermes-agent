import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { MANAGED_PROVIDER_SLUG } from '@/lib/provider-allowlist'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { resetScopeState, type ScopeState, seedScopeState, settingsTopHtml } from './__identity__/settings-scope/render'

/**
 * hc-1098 identity guard (hard rule 11) for the settings pages' 「应用于」 row.
 *
 * The goldens under `__identity__/settings-scope/` were recorded on fork main
 * 966a3aa618 with the same harness (render.tsx), before hc-1098 touched the
 * row: the title, the row and (for the model / tier page) the tier picker, with
 * APEX on screen, another assistant on screen, and the pages pointed at a third
 * — under every combination of the single_thread and multi_bot switches and
 * the tool view.
 */

const hermes = vi.hoisted(() => ({
  getGlobalModelInfo: vi.fn(),
  getGlobalModelOptions: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<object>()),
  // The row refreshes the profile list on mount; never answering keeps the seeded one.
  getProfiles: () => new Promise(() => {}),
  getGlobalModelInfo: (profile?: null | string) => hermes.getGlobalModelInfo(profile),
  getGlobalModelOptions: (opts?: unknown, profile?: null | string) => hermes.getGlobalModelOptions(opts, profile)
}))

vi.mock('@/app/hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: () => undefined }))

const GOLDEN = './__identity__/settings-scope'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  hermes.getGlobalModelInfo.mockResolvedValue({ model: 'apex-flash', provider: MANAGED_PROVIDER_SLUG })
  hermes.getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        authenticated: true,
        models: ['apex-flash', 'apex-pro', 'apex-max'],
        name: 'Apex-nodes.com',
        slug: MANAGED_PROVIDER_SLUG
      }
    ]
  })
})

afterEach(() => {
  resetScopeState()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  vi.clearAllMocks()
})

const MODES: [string, boolean, boolean, 'product' | 'technical'][] = [
  ['switch-off', false, false, 'product'],
  ['multi-bot-only', false, true, 'product'],
  ['product-one-assistant', true, false, 'product'],
  ['developer', true, true, 'technical'],
  ['product-multi-bot', true, true, 'product']
]

const PAGES: [string, ScopeState, boolean][] = [
  ['page-apex', 'apex', false],
  ['page-bot', 'bot', false],
  ['page-override', 'override', false],
  ['tier-apex', 'apex', true],
  ['tier-bot', 'bot', true],
  ['tier-override', 'override', true]
]

describe.each(MODES)('%s: the top of a settings page', (mode, singleThread, multiBot, toolView) => {
  it.each(PAGES)('%s', async (page, state, tier) => {
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)
    setToolViewMode(toolView)
    seedScopeState(state)

    await expect(await settingsTopHtml(tier)).toMatchFileSnapshot(`${GOLDEN}/${mode}-${page}.html`)
  })
})
