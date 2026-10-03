import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { I18nProvider } from '@/i18n'
import { $authState, canMountDesktopOnboarding, markSignedIn } from '@/store/auth'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $desktopOnboarding, cancelOnboardingFlow } from '@/store/onboarding'

import { AccountPanel } from './account-panel'

function ExpiredAccountWindow() {
  const auth = useStore($authState)
  const onboarding = useStore($desktopOnboarding)

  return (
    <>
      <AccountPanel />
      {canMountDesktopOnboarding(auth, onboarding.requested) && (
        <DesktopOnboardingOverlay enabled requestGateway={async method => (method === 'setup.runtime_check' ? { ok: true } : { provider_configured: true }) as never} />
      )}
    </>
  )
}

function CurrentPath() {
  const location = useLocation()

  return <output aria-label="current path">{location.pathname}</output>
}

function signIn() {
  $authState.set({
    account: { email: 'kael@apex-nodes.com', name: 'Kael', plan: 'pro' },
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
}

describe('expired account recovery', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $authState.set({
      account: { email: 'user@example.com', name: 'User', plan: '' },
      enabled: true,
      gateReason: 'unauthorized',
      loginTruth: true,
      status: 'expired'
    })
    $desktopOnboarding.set({
      configured: true,
      flow: { status: 'idle' },
      mode: 'oauth',
      providers: null,
      reason: null,
      requested: false,
      firstRunSkipped: false,
      manual: false,
      localEndpoint: false,
      needsCredential: false,
      managedAvailable: false,
      managedError: null,
      managedSubmitting: false,
      managedSyncing: false,
      byokFromLogin: false
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it.each([false, true])('opens managed sign-in despite a ready Gateway and firstRunSkipped=%s', async firstRunSkipped => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), firstRunSkipped })
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter>
          <ExpiredAccountWindow />
        </MemoryRouter>
      </I18nProvider>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /登录已失效/ }))
    })

    await waitFor(() => expect(screen.getByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')).toBeTruthy())
  })

  it('does not open sign-in merely because the account degraded to expired', () => {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter>
          <ExpiredAccountWindow />
        </MemoryRouter>
      </I18nProvider>
    )

    expect(screen.queryByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')).toBeNull()
    expect(screen.getByRole('button', { name: /登录已失效/ })).toBeTruthy()
  })
})

describe('signed-in account navigation', () => {
  beforeEach(() => {
    window.localStorage.clear()
    signIn()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('names the account intent, opens by keyboard, and routes Profile explicitly', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={['/start']}>
          <AccountPanel />
          <CurrentPath />
        </MemoryRouter>
      </I18nProvider>
    )

    const trigger = screen.getByRole('button', { name: '打开账户菜单: Kael' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })

    const profile = await screen.findByRole('menuitem', { name: '个人资料' })
    expect(screen.queryByText(/%/)).toBeNull()
    fireEvent.click(profile)

    await waitFor(() => expect(screen.getByRole('status', { name: 'current path' }).textContent).toBe('/profile'))
  })

  it('routes Settings only after its own explicit menu action', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={['/projects']}>
          <AccountPanel />
          <CurrentPath />
        </MemoryRouter>
      </I18nProvider>
    )

    fireEvent.keyDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '设置' }))

    await waitFor(() => expect(screen.getByRole('status', { name: 'current path' }).textContent).toBe('/settings'))
  })

  it('leaves secondary business destinations out of the legacy account menu', async () => {
    render(<I18nProvider configClient={null} initialLocale="zh"><MemoryRouter><AccountPanel businessChrome={false} /></MemoryRouter></I18nProvider>)
    fireEvent.keyDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { key: 'Enter' })
    await screen.findByRole('menuitem', { name: '设置' })
    expect(screen.queryByRole('menuitem', { name: '项目' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '定时运行' })).toBeNull()
  })

  it.each([
    ['项目', '/projects'],
    ['定时运行', '/cron'],
    ['连接助手', '/assistant'],
    ['历史会话', '/history'],
    ['交付物', '/deliverables']
  ])('keeps %s inside the account menu and routes only after selection', async (label, route) => {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={['/projects']}>
          <AccountPanel />
          <CurrentPath />
        </MemoryRouter>
      </I18nProvider>
    )

    expect(screen.queryByRole('menuitem', { name: label })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: label }))

    await waitFor(() => expect(screen.getByRole('status', { name: 'current path' }).textContent).toBe(route))
  })
})


describe('account sign-out failure recovery', () => {
  beforeEach(() => {
    signIn()
    clearNotifications()
    cancelOnboardingFlow()
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true, requested: false,
      managedAvailable: false, managedError: null, firstRunSkipped: true })
  })

  afterEach(() => {
    cleanup()
    clearNotifications()
    vi.restoreAllMocks()
    // @ts-expect-error test bridge cleanup
    delete window.hermesDesktop
  })

  it.each([
    ['expired server token', () => Promise.resolve({ ok: false, message: '401: expired' })],
    ['network failure', () => Promise.reject(new Error('offline'))]
  ])('retains the account and opens real sign-in after %s prevents revocation', async (_label, signOut) => {
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { signOut } } })
    render(<I18nProvider configClient={null} initialLocale="zh"><MemoryRouter><ExpiredAccountWindow /></MemoryRouter></I18nProvider>)
    fireEvent.keyDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect($notifications.get()).toHaveLength(1))
    expect($notifications.get()[0].message).toContain('退出登录未完成')
    expect($authState.get().status).toBe('signed-in')
    expect($authState.get().account.email).toBe('kael@apex-nodes.com')
    await act(async () => { $notifications.get()[0].action?.onClick() })
    await screen.findByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')
  })

  it('permits sign-in directly and ignores an old sign-out failure after an account replacement', async () => {
    let rejectLogout!: (error: Error) => void
    const signOut = vi.fn(() => new Promise((_resolve, reject) => { rejectLogout = reject }))
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { signOut,
      status: async () => ({ enabled: true, signedIn: true, accountId: 'new-owner', email: 'new@example.invalid' }) } } })
    render(<I18nProvider configClient={null} initialLocale="zh"><MemoryRouter><ExpiredAccountWindow /></MemoryRouter></I18nProvider>)
    fireEvent.keyDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '重新登录' }))
    await screen.findByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')
    await act(async () => { cancelOnboardingFlow(); $desktopOnboarding.set({ ...$desktopOnboarding.get(), requested: false }) })
    fireEvent.keyDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
    expect(screen.getByRole('menuitem', { name: '退出登录' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: '退出登录' }).querySelector('.animate-spin')).toBeTruthy()
    await act(async () => { markSignedIn({ email: 'new@example.invalid' }) })
    await act(async () => { rejectLogout(new Error('offline')) })
    expect($notifications.get()).toHaveLength(0)
    expect($authState.get().account.email).toBe('new@example.invalid')
    expect($desktopOnboarding.get().requested).toBe(false)
  })
})
