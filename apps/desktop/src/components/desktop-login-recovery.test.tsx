import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getApiRequestConnection, getApiRequestProfile, setApiRequestConnection, setApiRequestProfile } from '@/api/client'
import { I18nProvider } from '@/i18n/context'
import { $authState, markSignedIn, refreshChangedAccount, signOutAccount } from '@/store/auth'
import { $desktopUpdateProgress } from '@/store/desktop-update'
import { $desktopOnboarding, cancelOnboardingFlow, managedBrowserSignIn, managedDeepLinkSignIn, managedSignIn } from '@/store/onboarding'
import { $runtimeUpdateCheck, $runtimeUpdateChecking, $runtimeVersion } from '@/store/runtime-update'
import { $shellUpdate } from '@/store/shell-update'

import { DesktopLoginScreen } from './desktop-login-screen'

const configClient = { getConfig: async () => ({ display: { language: 'zh' } }), saveConfig: async () => ({ ok: true }) }

beforeEach(() => {
  cancelOnboardingFlow()
  $desktopOnboarding.set({ ...$desktopOnboarding.get(), requested: false, configured: false, managedAvailable: true,
    managedSubmitting: false, managedError: null, managedRuntimeRecovery: null })
  $runtimeUpdateCheck.set(null)
  $runtimeUpdateChecking.set(false)
  $runtimeVersion.set(null)
  $shellUpdate.set(null)
  $desktopUpdateProgress.set({ active: false, completedStages: [], currentStage: null, error: null, runtimeProgress: null, stages: [], targetVersion: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // @ts-expect-error — remove the injected test bridge.
  delete window.hermesDesktop
})

function renderGate() {
  render(<I18nProvider configClient={configClient} initialLocale="zh"><DesktopLoginScreen requestGateway={vi.fn() as never} /></I18nProvider>)
}

it('opens the formal local update confirmation from the blocking login gate, then permits retry', async () => {
  const browserSignIn = vi.fn().mockResolvedValue({ ok: false, message: 'MODEL_RUNTIME_UPDATE_REQUIRED', localRuntime: true })
  const applyUpdate = vi.fn().mockResolvedValue({ ok: true, reloadRequired: false })

  const checkUpdate = vi.fn().mockResolvedValue({ ok: true, updateAvailable: true, current: { version: 'old', key: 'old' },
    latest: { version: 'new', key: 'new', compatibilityNotes: null } })

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { browserSignIn }, runtime: {
    getVersion: async () => ({ ok: true, version: 'old', commit: null, branch: null, key: 'old' }), checkUpdate, applyUpdate
  } } })
  renderGate()
  await screen.findByRole('heading', { name: '开始使用' })
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await screen.findByText('请更新当前连接的 AI 引擎后重试登录')
  fireEvent.click(screen.getByRole('button', { name: '更新' }))
  fireEvent.click(await screen.findByRole('button', { name: '立即检查' }))
  await waitFor(() => expect(checkUpdate).toHaveBeenCalledOnce())
  fireEvent.click(await screen.findByRole('button', { name: '安装并重启' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.style.zIndex).toBe('1502')
  expect(window.document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')?.style.zIndex).toBe('1501')
  expect(applyUpdate).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '安装更新' }))
  await waitFor(() => expect(applyUpdate).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await waitFor(() => expect(browserSignIn).toHaveBeenCalledTimes(2))
})

it('remote recovery keeps login retry reachable and never offers this machine’s updater', async () => {
  const browserSignIn = vi.fn().mockResolvedValue({ ok: false, message: 'MODEL_RUNTIME_UPDATE_REQUIRED', localRuntime: false })
  const applyUpdate = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { browserSignIn }, runtime: { applyUpdate } } })
  renderGate()
  await screen.findByRole('heading', { name: '开始使用' })
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await screen.findByText('请更新当前连接的 AI 引擎后重试登录')
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await waitFor(() => expect(browserSignIn).toHaveBeenCalledTimes(2))
  expect(applyUpdate).not.toHaveBeenCalled()
})

it('an unconfirmed cloud grant shows account recovery retry without a Runtime update or expiry claim', async () => {
  const browserSignIn = vi.fn().mockResolvedValue({ ok: false, message: 'MANAGED_PROVISION_UNAVAILABLE' })
  const applyUpdate = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { browserSignIn }, runtime: { applyUpdate } } })
  renderGate()
  await screen.findByRole('heading', { name: '开始使用' })
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await screen.findByText('账户连接暂时无法确认,请重新登录重试')
  expect(screen.queryByText('登录已过期,请重新登录')).toBeNull()
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await waitFor(() => expect(browserSignIn).toHaveBeenCalledTimes(2))
  expect(applyUpdate).not.toHaveBeenCalled()
})

it('late logout and older browser sign-in never replace a newer account or complete its onboarding', async () => {
  let releaseLogout!: (result: unknown) => void
  let releaseLogin!: (result: unknown) => void
  const signOut = () => new Promise(resolve => {releaseLogout = resolve})
  const browserSignIn = () => new Promise(resolve => {releaseLogin = resolve})
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { signOut, browserSignIn,
    status: async () => ({ enabled: true, signedIn: true, accountId: 'fixture-b', email: 'b@example.test' }) },
    api: async () => ({ ok: true }) } })
  $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in', accountId: 'fixture-a', account: { email: 'a@example.test', name: '', plan: '' } })
  const logout = signOutAccount()
  markSignedIn({ email: 'b@example.test' })
  $authState.set({ ...$authState.get(), accountId: 'fixture-b' })
  releaseLogout({ ok: true })
  expect(await logout).toBe(false)
  expect($authState.get()).toMatchObject({ status: 'signed-in', accountId: 'fixture-b', account: { email: 'b@example.test' } })
  const requestGateway = vi.fn(async method => method === 'setup.status' ? { provider_configured: true } : { ok: true })
  const completed = vi.fn()
  const older = managedBrowserSignIn('apex', { requestGateway: requestGateway as never, onCompleted: completed })
  const releaseOlder = releaseLogin
  const newer = managedBrowserSignIn('google', { requestGateway: requestGateway as never, onCompleted: completed })
  // The second login supersedes the first before its success result arrives.
  const releaseNewer = releaseLogin
  await act(async () => {releaseNewer({ ok: false, message: 'MODEL_RUNTIME_UNAVAILABLE' }); await newer})
  // Only the latest flow remains visible; no gateway or completion side effect.
  releaseOlder({ ok: true, hasRelayKey: true, assignment: { scope: 'main', provider: 'custom', model: 'fixture-a',
    base_url: 'http://fixture.invalid/v1', api_key: 'hc903-fixture-a' } })
  await older
  expect(requestGateway).not.toHaveBeenCalled()
  expect(completed).not.toHaveBeenCalled()
})


it.each(['email', 'browser', 'deep-link'] as const)('ignores the %s managed receipt after its initiating profile changes', async kind => {
  const oldProfile = getApiRequestProfile()
  const oldConnection = getApiRequestConnection()
  setApiRequestConnection('fixture-remote')
  setApiRequestProfile('profile-a')
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => {resolve = done})
  const native = vi.fn().mockReturnValue(pending)
  const api = vi.fn()
  const requestGateway = vi.fn()
  const onCompleted = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: {
    managed: { signIn: native, browserSignIn: native, deepLinkSignIn: native }, api
  } })

  try {
    const context = { requestGateway: requestGateway as never, onCompleted }

    const flow = kind === 'email' ? managedSignIn('hc903@example.invalid', 'fixture-password', context)
      : kind === 'browser' ? managedBrowserSignIn('apex', context) : managedDeepLinkSignIn('fixture-code', context)

    expect(native.mock.calls[0][0].target).toEqual({ connectionId: 'fixture-remote', profile: 'profile-a' })
    setApiRequestProfile('profile-b')
    resolve({ ok: true, hasRelayKey: true, assignment: { scope: 'main', provider: 'custom', model: 'fixture-model',
      base_url: 'https://fixture.invalid/v1', api_key: 'hc903-fixture-key', desktop_managed_receipt: 'fixture-receipt' } })
    await flow
    expect($desktopOnboarding.get().managedSubmitting).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect(requestGateway).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  } finally {
    setApiRequestProfile(oldProfile)
    setApiRequestConnection(oldConnection)
  }
})

it.each([
  ['email', true], ['browser', true], ['deep-link', true],
  ['email', false], ['browser', false], ['deep-link', false]
] as const)('the %s flow restores account auth only after runtime readiness is %s', async (kind, ready) => {
  $authState.set({ ...$authState.get(), enabled: true, status: 'expired', accountId: 'fixture-account',
    account: { email: 'fixture@example.invalid', name: 'Fixture', plan: '' }, gateReason: 'unauthorized' })

  const status = vi.fn(async () => ({ enabled: true, signedIn: true, accountId: 'fixture-account',
    email: 'fixture@example.invalid', name: 'Fixture' }))

  const native = vi.fn(async () => {
    // The native credential replacement event closes the previous account.
    // The initiating flow must finish its own runtime check before reopening it.
    refreshChangedAccount(true)

    return { ok: true, hasRelayKey: true, assignment: { scope: 'main', provider: 'custom', model: 'fixture-model',
      base_url: 'http://fixture.invalid/v1', api_key: 'fixture-key' } }
  })

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: {
    managed: { signIn: native, browserSignIn: native, deepLinkSignIn: native, status },
    api: vi.fn(async () => ({ ok: true }))
  } })
  const requestGateway = vi.fn(async method => method === 'setup.status' ? { provider_configured: ready } : { ok: ready })
  const onCompleted = vi.fn()
  const context = { requestGateway: requestGateway as never, onCompleted }

  if (kind === 'email') {await managedSignIn('fixture@example.invalid', 'fixture-password', context)}
  else if (kind === 'browser') {await managedBrowserSignIn('apex', context)}
  else {await managedDeepLinkSignIn('fixture-code', context)}

  if (ready) {
    await waitFor(() => expect($authState.get()).toMatchObject({ status: 'signed-in', accountId: 'fixture-account',
      account: { email: 'fixture@example.invalid' }, gateReason: null }))
    expect(onCompleted).toHaveBeenCalledOnce()
  } else {
    expect($authState.get().status).toBe('signed-out')
    expect(status).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().managedError).toBeTruthy()
  }
})
