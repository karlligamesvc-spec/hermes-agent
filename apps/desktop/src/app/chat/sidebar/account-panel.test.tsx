import { useStore } from '@nanostores/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { I18nProvider } from '@/i18n'
import { $authState, canMountDesktopOnboarding } from '@/store/auth'
import { $desktopOnboarding } from '@/store/onboarding'

import { AccountPanel } from './account-panel'

function ExpiredAccountWindow() {
  const auth = useStore($authState)
  const onboarding = useStore($desktopOnboarding)

  return (
    <>
      <AccountPanel />
      {canMountDesktopOnboarding(auth, onboarding.requested) && (
        <DesktopOnboardingOverlay enabled requestGateway={vi.fn() as never} />
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

  it('opens managed sign-in when the user clicks the expired account card', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter>
          <ExpiredAccountWindow />
        </MemoryRouter>
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /登录已失效/ }))

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

  it.each([
    ['连接助手', '/assistant'],
    ['历史会话', '/history']
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
