import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $memoryLedger } from '@/store/memory-ledger'
import { $planUsage } from '@/store/plan-usage'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { $productSettingsViews, paletteRowSettingsTab, settingsRowFolded, settingsTabFolded } from './product-settings'

import { SettingsView } from './index'

vi.mock('./about-settings', () => ({ AboutSettings: () => <div>about-view</div> }))
vi.mock('./appearance-settings', () => ({ AppearanceSettings: () => <div>appearance-view</div> }))
vi.mock('./config-settings', () => ({
  ConfigSettings: ({ activeSectionId }: { activeSectionId: string }) => <div>config-{activeSectionId}</div>
}))
vi.mock('./gateway-settings', () => ({ GatewaySettings: () => <div>gateway-view</div> }))
vi.mock('./keybind-settings', () => ({ KeybindSettings: () => <div>keybind-view</div> }))
vi.mock('./keys-settings', () => ({ KEYS_VIEWS: ['tools', 'settings'], KeysSettings: () => <div>keys-view</div> }))
vi.mock('./notifications-settings', () => ({ NotificationsSettings: () => <div>notifications-view</div> }))
vi.mock('./personalization-settings', () => ({ PersonalizationSettings: () => <div>personalization-view</div> }))
vi.mock('./providers-settings', () => ({
  PROVIDER_VIEWS: ['accounts', 'keys', 'custom-endpoints'],
  ProvidersSettings: () => <div>providers-view</div>
}))
vi.mock('./sessions-settings', () => ({ SessionsSettings: () => <div>sessions-view</div> }))
vi.mock('./vault-settings', () => ({ vaultOwnerKey: () => 'owner', VaultSettings: () => <div>vault-view</div> }))

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
  setMode('switch-off')
  $authState.set(signedOut)
  $planUsage.set(null)
  $memoryLedger.set({ accountId: null, ledger: null, status: 'idle' })
  Reflect.deleteProperty(window, 'hermesDesktop')
  setRuntimeI18nLocale('en')
})

// Written out here rather than read from product-settings.ts: the check must not reuse what it checks.
const PRODUCT = [
  'config:personalization',
  'config:memory',
  'config:voice',
  'notifications',
  'config:appearance',
  'im',
  'usage',
  'about'
]

const OWN_KEY = [...PRODUCT.slice(0, -1), 'config:model', 'providers', 'about']

describe('$productSettingsViews', () => {
  it.each([
    ['switch-off', 'tier', null],
    ['switch-off', 'own-key', null],
    ['developer', 'tier', null],
    ['developer', 'own-key', null],
    ['product', 'tier', PRODUCT],
    ['product', 'apex', PRODUCT],
    ['product', 'own-key', OWN_KEY]
  ] as const)('%s, %s', (mode, account, views) => {
    setAccount(account)
    setMode(mode)

    expect($productSettingsViews.get()).toEqual(views)
  })

  it('product mode keeps ten sections at most', () => {
    setAccount('own-key')
    setMode('product')

    expect($productSettingsViews.get()?.length).toBeLessThanOrEqual(10)
  })
})

describe('paletteRowSettingsTab (⌘K row id → settings tab)', () => {
  it.each([
    ['set-config-model', 'config:model'],
    ['sp-config-memory', 'config:memory'],
    ['set-gateway', 'gateway'],
    ['set-keys&kview=tools', 'keys&kview=tools'],
    ['sp-providers&pview=accounts', 'providers&pview=accounts'],
    ['set-sessions', 'sessions'],
    ['set-about', 'about'],
    ['field-timezone', 'config:chat&field=timezone'],
    ['field-memory.provider', 'config:memory&field=memory.provider'],
    ['sp-config-field:tts.provider', 'config:voice&field=tts.provider'],
    ['sp-credential:TAVILY_API_KEY', 'keys'],
    ['sp-setting:appearance.theme', 'config:appearance'],
    ['archived-s-1', 'sessions'],
    // Not Settings': the Capabilities plugin rows, navigation, unknown fields.
    ['sp-plugin:desktop:demo', null],
    ['nav-settings', null],
    ['cc-usage', null],
    ['field-no.such.key', null],
    ['session-s-1', null]
  ])('%s → %s', (id, tab) => {
    expect(paletteRowSettingsTab(id)).toBe(tab)
  })
})

describe('settingsTabFolded / settingsRowFolded', () => {
  it.each([
    ['config:personalization', false],
    ['config:voice&field=tts.provider', false],
    ['config:memory', false],
    // 记忆 is the ledger in product mode: the engine's memory fields are not on it.
    ['config:memory&field=memory.provider', true],
    ['notifications', false],
    ['about', false],
    ['config:model', true],
    ['providers&pview=keys', true],
    ['gateway', true],
    ['keybinds', true],
    ['keys&kview=tools', true],
    ['vault', true],
    ['sessions', true],
    ['config:advanced', true]
  ] as const)('product mode on an APEX account: %s → %s', (tab, folded) => {
    setAccount('tier')
    setMode('product')

    expect(settingsTabFolded(tab)).toBe(folded)
  })

  it.each(['config:model', 'providers&pview=keys'])('own key: %s stays', tab => {
    setAccount('own-key')
    setMode('product')

    expect(settingsTabFolded(tab)).toBe(false)
  })

  it.each(['switch-off', 'developer'] as const)('%s: nothing folds', mode => {
    setAccount('tier')
    setMode(mode)

    for (const id of ['set-gateway', 'field-memory.provider', 'sp-credential:X', 'archived-s-1', 'set-config-chat']) {
      expect(settingsRowFolded(id)).toBe(false)
    }
  })
})

let location = ''

function LocationProbe() {
  const current = useLocation()
  location = `${current.pathname}${current.search}`

  return null
}

function renderSettings(route = '/settings') {
  setRuntimeI18nLocale('zh')

  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter initialEntries={[route]}>
        <SettingsView onClose={vi.fn()} />
        <LocationProbe />
      </MemoryRouter>
    </I18nProvider>
  )
}

/** The wide rail's links, by their visible names. */
function railLabels(): string[] {
  return [...document.querySelectorAll('[data-tour="overlay-nav"] [data-tour^="nav-"]')].map(link =>
    (link.textContent ?? '').trim()
  )
}

describe('the Settings overlay in product mode', () => {
  it.each([
    ['tier', ['个性化', '记忆', '语音', '通知', '外观', '连接微信和飞书', '用量', '关于']],
    ['apex', ['个性化', '记忆', '语音', '通知', '外观', '连接微信和飞书', '用量', '关于']],
    ['own-key', ['个性化', '记忆', '语音', '通知', '外观', '连接微信和飞书', '用量', '模型', '提供方', '关于']]
  ] as const)('%s: the rail', (account, labels) => {
    setAccount(account)
    setMode('product')
    renderSettings()

    expect(railLabels()).toEqual(labels)
    expect(screen.getByText('personalization-view')).toBeTruthy()
  })

  it('the rail drops export / import / reset; developer mode keeps them', () => {
    setAccount('tier')
    setMode('product')
    renderSettings()
    const rail = document.querySelector('[data-tour="overlay-nav"]') as HTMLElement

    expect(within(rail).queryAllByRole('button').length).toBe(8)
    cleanup()

    setMode('developer')
    renderSettings()
    const developerRail = document.querySelector('[data-tour="overlay-nav"]') as HTMLElement

    // 0.17.67's 17 sections plus the three footer buttons.
    expect(within(developerRail).queryAllByRole('button').length).toBe(20)
  })

  it.each([
    '/settings?tab=config:model',
    '/settings?tab=config:chat',
    '/settings?tab=config:workspace',
    '/settings?tab=config:safety',
    '/settings?tab=config:browser',
    '/settings?tab=config:advanced',
    '/settings?tab=vault&kind=login&label=GitHub',
    '/settings?tab=providers&pview=keys',
    '/settings?tab=gateway',
    '/settings?tab=connections',
    '/settings?tab=keybinds',
    '/settings?tab=keys&key=TAVILY_API_KEY',
    '/settings?tab=sessions&session=s-1'
  ])('a way into a folded page lands on 个性化: %s', route => {
    setAccount('tier')
    setMode('product')
    renderSettings(route)

    expect(screen.getByText('personalization-view')).toBeTruthy()

    for (const page of ['config-', 'vault-view', 'providers-view', 'gateway-view', 'keybind-view', 'keys-view']) {
      expect(document.body.textContent).not.toContain(page)
    }
  })

  it('switching to developer mode and back, the rail and the page follow at once', () => {
    setAccount('tier')
    setMode('developer')
    renderSettings('/settings?tab=gateway')

    expect(screen.getByText('gateway-view')).toBeTruthy()
    expect(railLabels()).toHaveLength(17)

    act(() => setToolViewMode('product'))

    expect(screen.getByText('personalization-view')).toBeTruthy()
    expect(railLabels()).toHaveLength(8)

    act(() => setToolViewMode('technical'))

    expect(screen.getByText('gateway-view')).toBeTruthy()
    expect(railLabels()).toHaveLength(17)
  })

  it.each(['switch-off', 'developer'] as const)('%s: 连接微信和飞书 and 用量 are not tabs', mode => {
    setAccount('tier')
    setMode(mode)

    for (const route of ['/settings?tab=im', '/settings?tab=usage']) {
      renderSettings(route)
      expect(screen.getByText('personalization-view')).toBeTruthy()
      cleanup()
    }
  })

  it('clicking a product tab moves the page and the URL', () => {
    setAccount('tier')
    setMode('product')
    renderSettings()

    fireEvent.click(document.querySelector('[data-tour="nav-config:voice"]')!)
    expect(screen.getByText('config-voice')).toBeTruthy()
    expect(location).toBe('/settings?tab=config%3Avoice')
  })
})

describe('the product pages', () => {
  it('记忆 is the ledger, not the engine’s memory fields', () => {
    setAccount('tier')
    setMode('product')
    $memoryLedger.set({ accountId: 'acct-1', ledger: null, status: 'unavailable' })
    renderSettings('/settings?tab=config:memory')

    expect(screen.getByText('它记得什么')).toBeTruthy()
    expect(document.body.textContent).not.toContain('config-memory')
  })

  it('记忆 without an APEX account says the ledger needs one', () => {
    setAccount('own-key')
    setMode('product')
    renderSettings('/settings?tab=config:memory')

    expect(screen.getByText('登录 APEX 账号后，这里会列出它记得的事，每条都能改、删、加。')).toBeTruthy()
  })

  it('developer mode keeps 记忆与上下文 as the engine’s fields', () => {
    setAccount('tier')
    setMode('developer')
    renderSettings('/settings?tab=config:memory')

    expect(screen.getByText('config-memory')).toBeTruthy()
    expect(railLabels()).toContain('记忆与上下文')
  })

  it.each([
    [{ period: 'month', planName: '快速', usedRatio: 0.18 }, '快速', '本月用了 18%'],
    [{ period: 'week', planName: '专业', usedRatio: 0.004 }, '专业', '本周用了 不到 1%'],
    [{ period: 'month', planName: '团队', usedRatio: null }, '团队', '不限量']
  ] as const)('用量: %j', (usage, plan, line) => {
    setAccount('tier')
    setMode('product')
    $planUsage.set({ accountId: 'acct-1', usage })
    renderSettings('/settings?tab=usage')

    expect(screen.getByText(plan)).toBeTruthy()
    expect(screen.getByText(line)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '查看使用记录' }))
    expect(location).toBe('/profile')
  })

  it('用量 with no plan line says so', () => {
    setAccount('own-key')
    setMode('product')
    renderSettings('/settings?tab=usage')

    expect(screen.getByText('还没读到用量。登录 APEX 账号后，这里会显示套餐和用了多少。')).toBeTruthy()
  })

  it('连接微信和飞书 lists the scan-to-bind channels', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { imEntry: { list: vi.fn(async () => ({ channels: [] })) } }
    })
    setAccount('tier')
    setMode('product')
    renderSettings('/settings?tab=im')

    expect(await screen.findByText('飞书')).toBeTruthy()
    expect(screen.getByText('微信')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '连接' }).length).toBeGreaterThanOrEqual(2)
  })
})
