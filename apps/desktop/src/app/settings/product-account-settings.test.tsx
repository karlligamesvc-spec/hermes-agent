// First, before any app module: the zone the reset times below are written in.
import '@/__identity__/single-thread-shell/time-zone'

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { DesktopAuthGate } from '@/app/desktop-auth-gate'
import type { DesktopPlanUsage } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { ACCOUNT_MENU_COPY } from '@/i18n/account-menu'
import { $authState, handleAuthGate } from '@/store/auth'
import { $managedReSignIn, closeManagedReSignIn } from '@/store/managed-re-sign-in'
import { requestManagedReSignIn } from '@/store/onboarding'
import { $planUsage, planTierOf, weeklyQuotaView } from '@/store/plan-usage'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'
import type { ProfileInfo } from '@/types/hermes'

import { $productSettingsViews, settingsTabFolded } from './product-settings'

import { SettingsView } from './index'

/**
 * hc-1133: what the account menu handed to Settings, the plans page, and the
 * read behind both, on the real SettingsView (pages outside them are markers).
 * Every way into these pages outside product mode is pinned in
 * src/account-menu-identity.test.tsx.
 */

// The auth gate re-reads main's status when it mounts; these cases seed the account themselves.
vi.mock(import('@/store/auth'), async importOriginal => ({
  ...(await importOriginal()),
  refreshAuthStatus: async () => undefined
}))

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

const signedOut = $authState.get()

function seedAccount({ plan = '', status = 'signed-in' }: { plan?: string; status?: 'expired' | 'signed-in' } = {}) {
  $authState.set({
    ...signedOut,
    account: { email: 'xiaoman@example.com', name: '小满', plan },
    accountId: 'acct-1',
    enabled: true,
    modelTiers: true,
    status
  })
}

function seedOwnKey() {
  $authState.set({
    ...signedOut,
    account: { email: '', name: '', plan: '' },
    accountId: null,
    enabled: false,
    status: 'disabled'
  })
}

function usageOf(usage: DesktopPlanUsage | null) {
  $planUsage.set({ accountId: 'acct-1', usage })
}

function setProductMode(on = true) {
  setToolViewMode(on ? 'product' : 'technical')
  setSingleThreadFlagForTest(true)
}

function Location() {
  const { pathname, search } = useLocation()

  return <output data-testid="location">{`${pathname}${search}`}</output>
}

function ReSignInProbe() {
  const request = useStore($managedReSignIn)

  return <output data-testid="re-sign-in">{request ? `open:${request.notice ?? ''}` : 'closed'}</output>
}

function renderSettings(route: string, locale: 'en' | 'zh' = 'zh') {
  setRuntimeI18nLocale(locale)

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MemoryRouter initialEntries={[route]}>
        <SettingsView onClose={vi.fn()} />
        <Location />
        <ReSignInProbe />
      </MemoryRouter>
    </I18nProvider>
  )
}

const location = () => screen.getByTestId('location').textContent

const railLink = (tab: string) => document.querySelector<HTMLElement>(`[data-tour="nav-${tab}"]`)!

const rowOf = (title: string) => screen.getByText(title).closest<HTMLElement>('.p5-row')!

const planColumn = (tier: string) => document.querySelector<HTMLElement>(`[data-apex-plan="${tier}"]`)!

beforeEach(() => {
  setProductMode()
  seedAccount()
  closeManagedReSignIn()
})

afterEach(() => {
  cleanup()
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  $activeGatewayProfile.set('default')
  $profiles.set([])
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $authState.set(signedOut)
  $planUsage.set(null)
  closeManagedReSignIn()
  Reflect.deleteProperty(window, 'hermesDesktop')
  setRuntimeI18nLocale('en')
})

afterAll(restoreRecordingTimeZone)

describe('Settings › 账号', () => {
  it('who is signed in and the plan', () => {
    usageOf({ period: 'month', planCode: 'free', planName: '免费', usedRatio: null })
    renderSettings('/settings?tab=account')

    expect(screen.getByText('小满')).toBeTruthy()
    expect(screen.getByText('xiaoman@example.com')).toBeTruthy()
    expect(rowOf('套餐').textContent).toContain('免费')
    expect(railLink('account').className).toContain('bg-(--ui-bg-tertiary)')
  })

  it('个人资料 opens the page the menu item opened', () => {
    renderSettings('/settings?tab=account')
    fireEvent.click(within(rowOf('个人资料')).getByRole('button', { name: '打开' }))

    expect(location()).toBe('/profile')
  })

  it('重新登录 asks for the same sign-in the menu item asked for', () => {
    renderSettings('/settings?tab=account')
    fireEvent.click(
      within(rowOf('登录过期，或者想换一个账号时用。').closest<HTMLElement>('.p5-row')!).getByRole('button')
    )

    expect(screen.getByTestId('re-sign-in').textContent).toBe('open:')
  })

  it('an expired session finds it there too, with the reason', () => {
    seedAccount({ status: 'expired' })
    renderSettings('/settings?tab=account')

    expect(screen.getByText('登录已失效')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))

    expect(screen.getByTestId('re-sign-in').textContent).toBe('open:登录已过期,请重新登录')
  })

  it.each([
    ['free', '升级'],
    ['fast', '升级'],
    ['advanced', '查看套餐']
  ])('%s: the plan’s button opens the plans page', (planCode, label) => {
    usageOf({ period: 'month', planCode, planName: 'x', usedRatio: null })
    renderSettings('/settings?tab=account')
    fireEvent.click(within(rowOf('套餐')).getByRole('button', { name: label }))

    expect(location()).toBe('/settings?tab=plans')
  })
})

describe('the sign-in screen over Settings: Settings is a modal, which would leave it dead', () => {
  const noPointer = () => document.body.style.pointerEvents === 'none'
  const signInUp = () => screen.queryByRole('heading', { name: '开始使用' }) !== null

  function renderWithGate(route: string) {
    setRuntimeI18nLocale('zh')

    return render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={[route]}>
          <SettingsView onClose={vi.fn()} />
          <DesktopAuthGate enabled requestGateway={(async () => ({ ok: true })) as never} />
          <Location />
        </MemoryRouter>
      </I18nProvider>
    )
  }

  it('Settings › 账号 › 重新登录: the screen takes clicks, and 返回 comes back to the same page', async () => {
    renderWithGate('/settings?tab=account')
    expect(noPointer()).toBe(true) // Without the fix this stays true under the login screen.

    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    await screen.findByRole('heading', { name: '开始使用' })

    await waitFor(() => expect(noPointer()).toBe(false))
    expect(document.querySelector('[data-overlay-surface]')).toBeNull()
    // Reachable: Radix's hideOthers would have taken these out of the accessibility tree.
    expect(screen.getByRole('button', { name: '登录 APEX 账户' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    await waitFor(() => expect(document.querySelector('[data-overlay-surface]')).not.toBeNull())
    expect(signInUp()).toBe(false)
    expect(location()).toBe('/settings?tab=account')
    expect(screen.getByText('xiaoman@example.com')).toBeTruthy()
  })

  it('a 401 from main while Settings is open: the screen takes clicks too', async () => {
    renderWithGate('/settings?tab=usage')
    expect(noPointer()).toBe(true)

    act(() => handleAuthGate({ reason: 'unauthorized', statusCode: 401 } as never))
    await screen.findByRole('heading', { name: '开始使用' })

    await waitFor(() => expect(noPointer()).toBe(false))
    expect(screen.getByRole('button', { name: '登录 APEX 账户' })).toBeTruthy()
  })

  it('a re-sign-in asked for by anything else (the IM binding, a refused send’s toast): the same', async () => {
    renderWithGate('/settings?tab=im')
    expect(noPointer()).toBe(true)

    act(() => requestManagedReSignIn('登录已过期,请重新登录'))
    await screen.findByRole('heading', { name: '开始使用' })

    await waitFor(() => expect(noPointer()).toBe(false))
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy()
  })

  it('a re-sign-in finished: the overlay is back and nothing blocks it', async () => {
    renderWithGate('/settings?tab=account')
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    await screen.findByRole('heading', { name: '开始使用' })

    act(() => closeManagedReSignIn())

    await waitFor(() => expect(document.querySelector('[data-overlay-surface]')).not.toBeNull())
    expect(signInUp()).toBe(false)
  })

  it('developer mode keeps what it had: the overlay stays mounted', async () => {
    setProductMode(false)
    renderWithGate('/settings?tab=about')

    act(() => requestManagedReSignIn(''))

    expect(document.querySelector('[data-overlay-surface]')).not.toBeNull()
  })
})

describe('Settings › 助手与记录', () => {
  it.each([
    ['定时运行', '/cron'],
    ['连接助手', '/assistant'],
    ['更早的对话', '/history']
  ])('%s opens the page the menu item opened', (title, path) => {
    renderSettings('/settings?tab=activity')
    fireEvent.click(within(rowOf(title)).getByRole('button', { name: '打开' }))

    expect(location()).toBe(path)
  })
})

describe('the rail', () => {
  it('the plans page has no entry of its own: 账号 stays lit', () => {
    renderSettings('/settings?tab=plans')

    expect(railLink('plans')).toBeNull()
    expect(railLink('account').className).toContain('bg-(--ui-bg-tertiary)')
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(document.querySelector('[data-apex-plans]')).not.toBeNull()
  })

  it('someone on their own key has no account to manage', () => {
    seedOwnKey()
    renderSettings('/settings?tab=account')

    expect(screen.getByText('personalization-view')).toBeTruthy()
    expect(railLink('account')).toBeNull()
    expect(railLink('activity')).toBeNull()

    for (const tab of ['account', 'activity', 'plans']) {
      expect(settingsTabFolded(tab)).toBe(true)
    }
  })

  it.each(['account', 'activity', 'plans'])('an APEX account keeps %s', tab => {
    expect(settingsTabFolded(tab)).toBe(false)
    expect($productSettingsViews.get()).toContain(tab)
  })

  it('going to developer mode from one of these pages lands on 个性化', () => {
    renderSettings('/settings?tab=plans')
    expect(document.querySelector('[data-apex-plans]')).not.toBeNull()

    act(() => setToolViewMode('technical'))

    expect(document.querySelector('[data-apex-plans]')).toBeNull()
    expect(screen.getByText('personalization-view')).toBeTruthy()
  })
})

describe('Settings › 用量: where 本周额度 in the menu leads', () => {
  const RESETS = '2026-11-08T16:00:00+00:00'
  const base = { period: 'month', planCode: 'free', planName: '免费', usedRatio: null } as const

  it('不限量 with no bar, while the ledger only records', () => {
    usageOf({ ...base, weekly: { enforced: false, resetsAt: RESETS, unlimited: false, usedRatio: 0.4 } })
    renderSettings('/settings?tab=usage')

    expect(rowOf('本周额度').textContent).toContain('不限量')
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    expect(document.body.textContent).not.toContain('还剩')
    expect(document.body.textContent).not.toContain('重置')
  })

  it('how much is left, the bar and the reset time, once it is enforced', () => {
    usageOf({ ...base, weekly: { enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: 0.25 } })
    renderSettings('/settings?tab=usage')

    expect(rowOf('本周额度').textContent).toContain('还剩 75%')
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('75')
    expect(rowOf('本周额度').textContent).toContain('11月8日 8:00 重置')
  })

  it('升级 opens the plans page', () => {
    usageOf(base)
    renderSettings('/settings?tab=usage')
    fireEvent.click(screen.getByRole('button', { name: '升级' }))

    expect(location()).toBe('/settings?tab=plans')
  })

  it('someone on their own key is offered no plan', () => {
    seedOwnKey()
    renderSettings('/settings?tab=usage')

    expect(screen.queryByRole('button', { name: '升级' })).toBeNull()
    expect(screen.queryByText('本周额度')).toBeNull()
    expect(screen.getByRole('button', { name: '查看使用记录' })).toBeTruthy()
  })
})

describe('the plans page', () => {
  it('lists 免费, Pro and Max with what the allowance is relative to', () => {
    renderSettings('/settings?tab=plans')

    expect(['free', 'pro', 'max'].map(tier => planColumn(tier).querySelector('span')?.textContent)).toEqual([
      '免费',
      'Pro',
      'Max'
    ])
    expect(planColumn('pro').textContent).toContain('免费的 5 倍')
    expect(planColumn('max').textContent).toContain('免费的 15 倍')
  })

  it.each([
    ['free', 'free', ['pro', 'max']],
    ['fast', 'pro', ['max']],
    ['advanced', 'max', []]
  ])('%s: its plan is marked, and only higher ones offer an upgrade', (planCode, tier, offered) => {
    usageOf({ period: 'month', planCode, planName: 'x', usedRatio: null })
    renderSettings('/settings?tab=plans')

    const current = [...document.querySelectorAll<HTMLElement>('[data-current="true"]')]

    expect(current.map(column => column.dataset.apexPlan)).toEqual([tier])
    expect(within(current[0]).getByText('当前套餐')).toBeTruthy()

    const withButton = ['free', 'pro', 'max'].filter(id => within(planColumn(id)).queryByRole('button'))

    expect(withButton).toEqual(offered)
  })

  it('a plan the page does not list marks none, and is not called one of these', () => {
    usageOf({ period: 'month', planCode: 'plus', planName: 'Plus', usedRatio: null })
    renderSettings('/settings?tab=plans')

    expect(document.querySelector('[data-current="true"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^升级到/ })).toHaveLength(2)
  })

  it('says usage is unlimited for now, and stops saying it once a limit is real', () => {
    usageOf({ period: 'month', planCode: 'free', planName: '免费', usedRatio: null, weekly: null })
    renderSettings('/settings?tab=plans')
    expect(document.querySelector('[data-apex-plans-unlimited-note]')).not.toBeNull()
    cleanup()

    usageOf({
      period: 'month',
      planCode: 'free',
      planName: '免费',
      usedRatio: null,
      weekly: { enforced: true, resetsAt: '2026-11-08T16:00:00+00:00', unlimited: false, usedRatio: 0.2 }
    })
    renderSettings('/settings?tab=plans')
    expect(document.querySelector('[data-apex-plans-unlimited-note]')).toBeNull()
  })

  it.each([
    ['zh', '升级到 Pro', '付费功能正在测试中。付费功能后续推出，现在不会扣费。'],
    ['en', 'Upgrade to Max', 'Paid plans are still being tested.They will launch later. You have not been charged.']
  ] as const)('%s: a paid button says it is in testing, and buys nothing', (locale, label, notice) => {
    // Every call the page could make on the way to a purchase has to go through one of these.
    const bridgeCalls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const record = (name: string) => new Proxy(vi.fn(), { apply: () => void bridgeCalls.push(name) })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: new Proxy(
        {},
        {
          get: (_target, section: string) =>
            section === 'managed'
              ? new Proxy({}, { get: (_t, method: string) => (method === 'planUsage' ? undefined : record(method)) })
              : record(section)
        }
      )
    })

    usageOf({ period: 'month', planCode: 'free', planName: '免费', usedRatio: null })
    renderSettings('/settings?tab=plans', locale)
    const route = location()

    expect(document.querySelector('[data-apex-plans-testing-notice]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: label }))

    expect(document.querySelector('[data-apex-plans-testing-notice]')?.textContent).toBe(notice)
    expect(screen.getByRole('status').textContent).toBe(notice)
    expect(location()).toBe(route)
    expect(bridgeCalls).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
    openSpy.mockRestore()
  })

  it.each(['zh', 'en'] as const)('%s: shows no price and no amount of money', locale => {
    renderSettings('/settings?tab=plans', locale)
    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement)

    expect(document.body.textContent).not.toMatch(/[¥$€￥]|元|\bCNY\b|\bUSD\b|\bRMB\b|\/\s*(?:月|周|mo|month|week)/i)
  })
})

describe('several assistants: these pages are the account’s, not the one on screen', () => {
  const ROWS = [
    { is_default: true, name: 'default' },
    { name: 'apex-bot-2', ui_meta: { apex: { created: 1, name: '剪辑助手', origin: 'product' } } }
  ]

  beforeEach(() => {
    $profiles.set(
      ROWS.map(
        row =>
          ({
            has_env: false,
            is_default: Boolean(row.is_default),
            model: null,
            name: row.name
          }) as unknown as ProfileInfo
      )
    )
    resetBotRosterForTest(botRosterFrom(ROWS, () => true))
    setMultiBotFlagForTest(true)
    $activeGatewayProfile.set('apex-bot-2')
  })

  it.each(['account', 'plans', 'usage'])('%s: the title names no assistant', tab => {
    renderSettings(`/settings?tab=${tab}`)

    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('剪辑助手')
  })

  it.each(['activity', 'config:voice', 'notifications'])('%s: the title still says whose they are', tab => {
    renderSettings(`/settings?tab=${tab}`)

    expect(screen.getByRole('heading', { name: '剪辑助手 的设置' })).toBeTruthy()
  })
})

describe('weeklyQuotaView: what makes the numbers a limit', () => {
  const RESETS = '2026-11-08T16:00:00+00:00'

  const usage = (weekly: DesktopPlanUsage['weekly']): DesktopPlanUsage => ({
    period: 'month',
    planName: '免费',
    usedRatio: null,
    weekly
  })

  it.each([
    ['no usage line', null, { kind: 'unknown' }],
    ['no weekly field', usage(undefined), { kind: 'unlimited' }],
    ['ledger off', usage(null), { kind: 'unlimited' }],
    ['shadow', usage({ enforced: false, resetsAt: RESETS, unlimited: false, usedRatio: 0.4 }), { kind: 'unlimited' }],
    [
      'shadow, over',
      usage({ enforced: false, resetsAt: RESETS, unlimited: false, usedRatio: 3 }),
      { kind: 'unlimited' }
    ],
    [
      'enforced, uncapped',
      usage({ enforced: true, resetsAt: RESETS, unlimited: true, usedRatio: null }),
      { kind: 'unlimited' }
    ],
    [
      'enforced, no ratio',
      usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: null }),
      { kind: 'unknown' }
    ],
    [
      'enforced, no reset',
      usage({ enforced: true, resetsAt: null, unlimited: false, usedRatio: 0.4 }),
      { kind: 'unknown' }
    ],
    [
      'enforced',
      usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: 0.25 }),
      { kind: 'limited', remainingRatio: 0.75, resetsAt: RESETS, usedUp: false }
    ],
    [
      'enforced, exactly at the allowance',
      usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: 1 }),
      { kind: 'limited', remainingRatio: 0, resetsAt: RESETS, usedUp: true }
    ],
    [
      'enforced, past it',
      usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: 1.5 }),
      { kind: 'limited', remainingRatio: 0, resetsAt: RESETS, usedUp: true }
    ]
  ])('%s', (_label, line, expected) => {
    expect(weeklyQuotaView(line)).toEqual(expected)
  })

  const SRC = join(__dirname, '..', '..')

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name)

      if (statSync(path).isDirectory()) {
        return name === '__identity__' ? [] : sourceFiles(path)
      }

      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  }

  it('is the only code that reads the weekly numbers (census)', () => {
    const readers = sourceFiles(SRC)
      .filter(file => /\busage\??\.weekly\b|\.weekly\?*\./.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC, file))

    expect(readers).toEqual(['store/plan-usage.ts'])
  })
})

describe('planTierOf', () => {
  it.each([
    ['free', 'free'],
    ['fast', 'pro'],
    ['advanced', 'max'],
    // `pro` is apexnodes_billing's old alias for `advanced`, so it cannot be read as the plan listed as Pro.
    ['pro', null],
    ['plus', null],
    ['constructor', null],
    ['', null],
    [undefined, null],
    [null, null]
  ])('%s → %s', (code, tier) => {
    expect(planTierOf(code)).toBe(tier)
  })
})

describe('the copy', () => {
  it.each(['en', 'zh', 'zh-hant'] as const)('%s names no price and no amount', locale => {
    const copy = ACCOUNT_MENU_COPY[locale]

    const strings = [
      copy.plansTitle,
      copy.plansIntro,
      copy.plansUnlimitedNote,
      copy.priceSoon,
      copy.testingTitle,
      copy.testingBody,
      ...Object.values(copy.planAllowances)
    ]

    for (const text of strings) {
      expect(text).not.toMatch(/[¥$€￥]|元|\bCNY\b|\bUSD\b|\bRMB\b/)
    }

    expect(copy.planAllowances.pro).toMatch(/5/)
    expect(copy.planAllowances.max).toMatch(/15/)
    expect(copy.planAllowances.free).not.toMatch(/\d/)
  })

  it('ja and ar read English rather than a half-translated page', () => {
    expect(ACCOUNT_MENU_COPY.ja).toBe(ACCOUNT_MENU_COPY.en)
    expect(ACCOUNT_MENU_COPY.ar).toBe(ACCOUNT_MENU_COPY.en)
  })
})

describe('reading', () => {
  it('the pages read the plan when they open', async () => {
    const planUsage = vi.fn(async () => ({
      ok: true,
      usage: { period: 'month', planCode: 'advanced', planName: '高级', usedRatio: null, weekly: null }
    }))

    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { planUsage } } })
    renderSettings('/settings?tab=plans')

    await waitFor(() => expect(planColumn('max').dataset.current).toBe('true'))
    expect(planUsage).toHaveBeenCalled()
  })
})
