// First, before any app module: the zone the reset times below are written in.
import '@/__identity__/single-thread-shell/time-zone'

import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import { DesktopAuthGate } from '@/app/desktop-auth-gate'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { DesktopPlanUsage, DesktopPlanUsageResult } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $accountTeam } from '@/store/account-team'
import { $authState, markSignedIn } from '@/store/auth'
import { $managedReSignIn, closeManagedReSignIn } from '@/store/managed-re-sign-in'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $planUsage } from '@/store/plan-usage'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'
import type { ProfileInfo } from '@/types/hermes'

/**
 * hc-1133: the account menu on the real row, through the real sidebar surface.
 * The surfaces that must not change outside product mode are pinned in
 * src/account-menu-identity.test.tsx.
 */

// The auth gate re-reads main's status when it mounts; these cases seed the account themselves.
vi.mock(import('@/store/auth'), async importOriginal => ({
  ...(await importOriginal()),
  refreshAuthStatus: async () => undefined
}))

const noop = () => {}

const ACTIONS: SidebarActions = {
  onArchiveSession: noop,
  onBranchSession: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onManageCronJob: noop,
  onNavigate: noop,
  onNewSessionInWorkspace: noop,
  onNewSessionSplit: noop,
  onResumeSession: noop,
  onTriggerCronJob: noop
}

const ACCOUNT = { email: 'xiaoman@example.com', name: '小满', plan: '' }

function seedAccount(plan = ''): void {
  $authState.set({
    account: { ...ACCOUNT, plan },
    accountId: 'acct-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
}

function Location() {
  const { pathname, search } = useLocation()

  return <output data-testid="location">{`${pathname}${search}`}</output>
}

function ReSignInProbe() {
  return <output data-testid="re-sign-in">{useStore($managedReSignIn) ? 'open' : 'closed'}</output>
}

function renderSidebar(locale: 'en' | 'zh' = 'zh') {
  setRuntimeI18nLocale(locale)

  return render(
    <MemoryRouter initialEntries={['/thread-root']}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <SidebarProvider>
          <SidebarSurface actions={ACTIONS} currentView="chat" />
        </SidebarProvider>
        <Location />
        <ReSignInProbe />
      </I18nProvider>
    </MemoryRouter>
  )
}

interface Bridge {
  openExternal?: ReturnType<typeof vi.fn>
  planUsage?: () => Promise<DesktopPlanUsageResult>
  signOut?: () => Promise<unknown>
}

function installBridge({ openExternal, planUsage, signOut }: Bridge = {}): void {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      imEntry: { list: vi.fn(async () => ({ channels: [] })) },
      managed: { planUsage, signOut },
      openExternal
    }
  })
}

const reads = (usage: DesktopPlanUsage | null) => async (): Promise<DesktopPlanUsageResult> => ({ ok: true, usage })

async function openMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByRole('button', { name: /^打开账户菜单|^Open account menu/ }), {
    button: 0,
    ctrlKey: false
  })

  return (await screen.findByRole('menu')) as HTMLElement
}

const menuItems = () => screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
const quotaItem = (menu: HTMLElement) => menu.querySelector<HTMLElement>('[data-apex-weekly-quota]')!

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  seedAccount()
  clearNotifications()
  closeManagedReSignIn()
  installBridge()
})

afterEach(() => {
  cleanup()
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  $activeGatewayProfile.set('default')
  $profiles.set([])
  setSingleThreadFlagForTest(false)
  $planUsage.set(null)
  $accountTeam.set({ accountId: null, team: null })
  clearNotifications()
  closeManagedReSignIn()
  Reflect.deleteProperty(window, 'hermesDesktop')
  setRuntimeI18nLocale('en')
})

afterAll(restoreRecordingTimeZone)

describe('the menu, top to bottom', () => {
  it('the account, the plan card, 设置, 联系我们, 退出登录 and nothing else', async () => {
    renderSidebar()
    const menu = await openMenu()

    const order = [
      menu.querySelector('[data-apex-account-menu-identity]'),
      menu.querySelector('[data-apex-account-plan-card]'),
      screen.getByRole('menuitem', { name: '设置' }),
      screen.getByRole('menuitem', { name: '联系我们' }),
      screen.getByRole('menuitem', { name: '退出登录' })
    ]

    expect(order.every(Boolean)).toBe(true)

    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }

    const identity = menu.querySelector<HTMLElement>('[data-apex-account-menu-identity]')!

    expect(within(identity).getByText('小满')).toBeTruthy()
    expect(within(identity).getByText('xiaoman@example.com')).toBeTruthy()
    expect(menuItems()).toEqual(['升级', '本周额度暂时读不到', '设置', '联系我们', '退出登录'])
  })

  it.each(['个人资料', '定时运行', '连接助手', '更早的对话', '重新登录'])('%s is no longer in it', async label => {
    renderSidebar()
    await openMenu()

    expect(screen.queryByRole('menuitem', { name: label })).toBeNull()
  })

  it('reads the plan again each time it opens', async () => {
    const planUsage = vi.fn(reads({ period: 'month', planName: '免费', usedRatio: null, weekly: null }))
    installBridge({ planUsage })
    renderSidebar()
    await waitFor(() => expect(planUsage).toHaveBeenCalledTimes(1))

    await openMenu()

    await waitFor(() => expect(planUsage).toHaveBeenCalledTimes(2))
  })

  it('keeps the team line for an account that has a team', async () => {
    $accountTeam.set({ accountId: 'acct-1', team: { isAdmin: true, name: '小满的团队', status: 'active' } })
    renderSidebar()
    const menu = await openMenu()

    expect(menu.querySelector('[data-apex-account-team]')?.textContent).toContain('小满的团队')
  })
})

describe('this week’s allowance', () => {
  const RESETS = '2026-11-08T16:00:00+00:00'

  const usage = (weekly: DesktopPlanUsage['weekly']): DesktopPlanUsage => ({
    period: 'month',
    planCode: 'free',
    planName: '免费',
    usedRatio: null,
    weekly
  })

  // What production answers today: the ledger records (hc-1119, shadow) and refuses nothing.
  const SHADOW = { enforced: false, resetsAt: RESETS, unlimited: false, usedRatio: 0.4 }

  describe.each([
    ['the ledger only records (shadow)', usage(SHADOW)],
    ['the ledger only records and is over the allowance', usage({ ...SHADOW, usedRatio: 1.3 })],
    ['the ledger is off', usage(null)],
    ['a cloud from before the ledger', usage(undefined)],
    [
      'enforced, with this account uncapped',
      usage({ enforced: true, resetsAt: RESETS, unlimited: true, usedRatio: null })
    ]
  ])('%s', (_label, line) => {
    it('says 不限量: no percentage, no bar, no reset time', async () => {
      installBridge({ planUsage: reads(line) })
      renderSidebar()
      const menu = await openMenu()

      await waitFor(() => expect(quotaItem(menu).getAttribute('data-apex-weekly-quota')).toBe('unlimited'))
      expect(quotaItem(menu).textContent).toContain('本周额度')
      expect(quotaItem(menu).textContent).toContain('不限量')
      expect(menu.textContent).not.toContain('还剩')
      expect(menu.textContent).not.toContain('%')
      expect(menu.textContent).not.toContain('重置')
      expect(menu.querySelector('[role="progressbar"]')).toBeNull()
    })
  })

  it.each([
    ['a little used', 0.05, '还剩 95%', 95],
    ['nothing used', 0, '还剩 100%', 100],
    ['almost used up: never a 0% while some is left', 0.996, '还剩 不到 1%', 0]
  ])('enforced, %s: how much is left, the bar and when it resets', async (_label, usedRatio, left, barValue) => {
    installBridge({ planUsage: reads(usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio })) })
    renderSidebar()
    const menu = await openMenu()

    await waitFor(() => expect(quotaItem(menu).getAttribute('data-apex-weekly-quota')).toBe('limited'))
    expect(quotaItem(menu).textContent).toContain(left)
    expect(menu.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(String(barValue))
    expect(menu.querySelector('[data-apex-weekly-meter]')?.textContent).toBe('11月8日 8:00 重置')
  })

  it('enforced and past the allowance: 已用完 with an empty, red bar', async () => {
    installBridge({ planUsage: reads(usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: 1.25 })) })
    renderSidebar()
    const menu = await openMenu()

    await waitFor(() => expect(quotaItem(menu).textContent).toContain('已用完'))

    const bar = menu.querySelector('[role="progressbar"]')

    expect(bar?.getAttribute('aria-valuenow')).toBe('0')
    expect(bar?.querySelector('.bg-destructive')).not.toBeNull()
    expect(menu.querySelector('[data-apex-weekly-meter]')?.textContent).toBe('11月8日 8:00 重置')
  })

  it.each([
    ['no number', { enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: null }],
    ['no reset time', { enforced: true, resetsAt: null, unlimited: false, usedRatio: 0.2 }]
  ])('enforced with %s: it cannot say, and never says 不限量', async (_label, weekly) => {
    installBridge({ planUsage: reads(usage(weekly)) })
    renderSidebar()
    const menu = await openMenu()

    await waitFor(() => expect(quotaItem(menu).getAttribute('data-apex-weekly-quota')).toBe('unknown'))
    expect(quotaItem(menu).textContent).toContain('暂时读不到')
    expect(menu.textContent).not.toContain('不限量')
  })

  it('nothing read yet, or no line from the cloud: it cannot say either', async () => {
    installBridge({ planUsage: reads(null) })
    renderSidebar()
    const menu = await openMenu()

    await waitFor(() => expect(quotaItem(menu).getAttribute('data-apex-weekly-quota')).toBe('unknown'))
    expect(menu.textContent).not.toContain('不限量')
  })

  it('English', async () => {
    installBridge({ planUsage: reads(usage({ enforced: true, resetsAt: RESETS, unlimited: false, usedRatio: 0.05 })) })
    renderSidebar('en')
    const menu = await openMenu()

    await waitFor(() => expect(quotaItem(menu).textContent).toContain('95% left'))
    expect(quotaItem(menu).textContent).toContain('Weekly usage')
    expect(menu.querySelector('[data-apex-weekly-meter]')?.textContent).toBe('Resets Nov 8, 8:00 AM')
  })

  it('English, while nothing is limited', async () => {
    installBridge({ planUsage: reads(usage(SHADOW)) })
    renderSidebar('en')
    const menu = await openMenu()

    await waitFor(() => expect(quotaItem(menu).textContent).toContain('Unlimited'))
  })
})

describe('the plan’s name', () => {
  it.each([
    ['free', '免费', '免费', '升级'],
    ['fast', '快速', 'Pro', '升级'],
    ['advanced', '高级', 'Max', '查看套餐'],
    // A code the plans page does not list keeps the cloud's name, and is not called something it is not.
    ['plus', 'Plus 旧套餐', 'Plus 旧套餐', '升级'],
    // apexnodes_billing's alias: `pro` is the old name of `advanced`, not the plan listed as Pro.
    ['pro', '高级', '高级', '升级']
  ])('%s from the cloud reads as its plans-page name', async (planCode, planName, shown, button) => {
    installBridge({ planUsage: reads({ period: 'month', planCode, planName, usedRatio: null, weekly: null }) })
    renderSidebar()
    const menu = await openMenu()

    await waitFor(() => expect(menu.querySelector('[data-apex-account-plan]')?.textContent).toBe(shown))
    expect(screen.getByRole('menuitem', { name: button })).toBeTruthy()
  })

  it('with no line read, the code the sign-in gave', async () => {
    seedAccount('fast')
    renderSidebar()
    const menu = await openMenu()

    expect(menu.querySelector('[data-apex-account-plan]')?.textContent).toBe('Pro')
  })

  it('with nothing known, a plain word', async () => {
    renderSidebar()
    const menu = await openMenu()

    expect(menu.querySelector('[data-apex-account-plan]')?.textContent).toBe('当前套餐')
  })

  it('the row under the name uses the same name', async () => {
    installBridge({ planUsage: reads({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18 }) })
    const { container } = renderSidebar()

    await waitFor(() =>
      expect(container.querySelector('[data-single-thread-account-line]')?.textContent).toBe('Pro · 本月用了 18%')
    )
  })
})

describe('where it leads', () => {
  it.each([
    ['升级', '/settings?tab=plans'],
    ['本周额度', '/settings?tab=usage'],
    ['设置', '/settings']
  ])('%s opens %s', async (label, path) => {
    renderSidebar()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(path))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('联系我们 hands the website’s address to the mail app and keeps it on screen', async () => {
    const openExternal = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    installBridge({ openExternal })
    renderSidebar()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '联系我们' }))

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('mailto:support@apex-nodes.com'))
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect($notifications.get()).toHaveLength(1)
    expect($notifications.get()[0].message).toContain('support@apex-nodes.com')

    await act(async () => $notifications.get()[0].action?.onClick())

    expect(writeText).toHaveBeenCalledWith('support@apex-nodes.com')
    Reflect.deleteProperty(navigator, 'clipboard')
  })
})

describe('退出登录 (hc-1114, hc-1120, hc-1121: the flow behind it does not change)', () => {
  it('signs out through main, once, and shows it is working while it does', async () => {
    let finish!: (result: unknown) => void
    const signOut = vi.fn(() => new Promise(resolve => (finish = resolve)))
    installBridge({ signOut })
    renderSidebar()
    await openMenu()

    const item = screen.getByRole('menuitem', { name: '退出登录' })

    fireEvent.click(item)
    fireEvent.click(item)

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
    expect(screen.getByRole('menuitem', { name: '退出登录' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: '退出登录' }).querySelector('.animate-spin')).toBeTruthy()

    await act(async () => finish({ ok: true }))

    await waitFor(() => expect($authState.get().status).toBe('signed-out'))
    expect($notifications.get()).toHaveLength(0)
  })

  it('signing out and back in leaves the menu closed, and on a later open shows the new account', async () => {
    installBridge({ signOut: async () => ({ ok: true }) })
    renderSidebar()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect($authState.get().status).toBe('signed-out'))

    act(() => {
      $authState.set({
        ...$authState.get(),
        account: { email: 'next@example.com', name: '下一位', plan: '' },
        accountId: 'acct-2',
        status: 'signed-in'
      })
    })

    await screen.findByRole('button', { name: '打开账户菜单: 下一位' })
    expect(screen.queryByRole('menu')).toBeNull()

    const menu = await openMenu()

    expect(menu.querySelector('[data-apex-account-menu-identity]')?.textContent).toContain('next@example.com')
    expect(menu.textContent).not.toContain('xiaoman@example.com')
  })

  it.each([
    ['an expired server token', () => Promise.resolve({ message: '401: expired', ok: false })],
    ['no network', () => Promise.reject(new Error('offline'))]
  ])(
    'when %s stops it: the account stays, the menu closes, the toast leads to the sign-in',
    async (_label, signOut) => {
      installBridge({ signOut })
      renderSidebar()
      await openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))

      await waitFor(() => expect($notifications.get()).toHaveLength(1))

      const [notice] = $notifications.get()

      expect(notice.message).toContain('退出登录未完成')
      expect(notice.action?.label).toBe('重新登录')
      expect($authState.get().status).toBe('signed-in')
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

      await act(async () => notice.action?.onClick())

      expect(screen.getByTestId('re-sign-in').textContent).toBe('open')
    }
  )

  it('it can be tried again after a failure', async () => {
    const signOut = vi.fn(async () => ({ ok: false }))
    installBridge({ signOut })
    renderSidebar()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    signOut.mockResolvedValueOnce({ ok: true })
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect($authState.get().status).toBe('signed-out'))
    expect(signOut).toHaveBeenCalledTimes(2)
  })

  it('a failure for an account already replaced says nothing', async () => {
    let reject!: (error: Error) => void
    installBridge({ signOut: () => new Promise((_resolve, rejectNow) => (reject = rejectNow)) })
    renderSidebar()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))

    await act(async () => {
      markSignedIn({ email: 'new@example.invalid' })
    })
    await act(async () => reject(new Error('offline')))

    expect($notifications.get()).toHaveLength(0)
    expect($managedReSignIn.get()).toBeNull()
  })
})

describe('a session that lost its login still has its way back', () => {
  it('an expired session gets the 「登录已失效」 card, which opens the sign-in', async () => {
    $authState.set({ ...$authState.get(), status: 'expired' })
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: /登录已失效/ }))

    expect(screen.getByTestId('re-sign-in').textContent).toBe('open')
  })
})

describe('several assistants: the account is not one of them', () => {
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

  it('with another assistant on screen, the menu is the account: its name, email and plan', async () => {
    installBridge({
      planUsage: reads({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: null, weekly: null })
    })
    renderSidebar()
    const menu = await openMenu()

    await waitFor(() => expect(menu.querySelector('[data-apex-account-plan]')?.textContent).toBe('Pro'))
    expect(menu.textContent).toContain('小满')
    expect(menu.textContent).toContain('xiaoman@example.com')
    expect(menu.textContent).not.toContain('剪辑助手')
  })

  it('switching assistants neither re-reads the plan nor changes what it says', async () => {
    const planUsage = vi.fn(
      reads({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18, weekly: null })
    )

    installBridge({ planUsage })
    const { container } = renderSidebar()
    const line = () => container.querySelector('[data-single-thread-account-line]')?.textContent

    await waitFor(() => expect(line()).toBe('Pro · 本月用了 18%'))
    const before = planUsage.mock.calls.length

    act(() => $activeGatewayProfile.set('default'))

    expect(line()).toBe('Pro · 本月用了 18%')
    expect(planUsage.mock.calls.length).toBe(before)
  })
})

describe('the auth gate over the row', () => {
  it('a re-sign-in asked for from the failed sign-out’s toast opens the first-open screen', async () => {
    installBridge({ signOut: async () => ({ ok: false }) })
    setRuntimeI18nLocale('zh')
    render(
      <MemoryRouter initialEntries={['/thread-root']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <SidebarProvider>
            <SidebarSurface actions={ACTIONS} currentView="chat" />
          </SidebarProvider>
          <DesktopAuthGate enabled requestGateway={(async () => ({ ok: true })) as never} />
        </I18nProvider>
      </MemoryRouter>
    )
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect($notifications.get()).toHaveLength(1))

    await act(async () => $notifications.get()[0].action?.onClick())

    expect(await screen.findByRole('heading', { name: '开始使用' })).toBeTruthy()
  })
})
