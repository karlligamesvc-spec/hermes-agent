import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { setRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'
import {
  $desktopOnboarding,
  cancelOnboardingFlow,
  managedBrowserSignIn,
  managedDeepLinkSignIn,
  managedSignIn
} from '@/store/onboarding'

import { DesktopLoginScreen } from './desktop-login-screen'

// Literal copy, not read back from the module under test.
const LIMIT_ZH = '这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。'

const LIMIT_EN =
  'This account is already signed in on the maximum number of computers. Sign out of APEX on one of them, then sign in here.'

const configClient = {
  getConfig: async () => ({ display: { language: 'zh' } }),
  saveConfig: async () => ({ ok: true })
}

beforeEach(() => {
  cancelOnboardingFlow()
  $desktopOnboarding.set({
    ...$desktopOnboarding.get(),
    managedAvailable: true,
    managedSubmitting: false,
    managedError: null,
    managedRuntimeRecovery: null
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setRuntimeI18nLocale('zh')
  // @ts-expect-error — remove the injected test bridge.
  delete window.hermesDesktop
})

function nativeAnswers(message: string) {
  const native = vi.fn().mockResolvedValue({ ok: false, hasRelayKey: false, assignment: null, message })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      managed: { signIn: native, browserSignIn: native, deepLinkSignIn: native },
      api: vi.fn()
    }
  })

  return native
}

const context = () => ({ requestGateway: vi.fn() as never, onCompleted: vi.fn() })

it.each([
  ['MANAGED_DEVICE_LIMIT_REACHED', 'zh', LIMIT_ZH],
  [
    'MANAGED_DEVICE_LIMIT_REACHED',
    'zh-hant',
    '這個帳戶登入的電腦數已達上限。請先在其中一台電腦的 APEX 裡登出，再回到這裡登入。'
  ],
  ['MANAGED_DEVICE_LIMIT_REACHED', 'en', LIMIT_EN],
  [
    'MANAGED_DEVICE_LIMIT_REACHED',
    'ja',
    'このアカウントでログインしているパソコンが上限に達しています。いずれかのパソコンの APEX でログアウトしてから、ここでログインしてください。'
  ],
  ['MANAGED_DEVICE_LIMIT_REACHED', 'ar', LIMIT_EN],
  // Every other provision failure keeps the retry line it had.
  ['MANAGED_PROVISION_UNAVAILABLE', 'zh', '账户连接暂时无法确认,请重新登录重试'],
  // Only Native's marker maps; a raw server code or HTTP body is never shown or matched.
  ['desktop_device_key_limit_reached', 'zh', '登录失败,请检查邮箱或密码'],
  ['409: {"detail":{"code":"desktop_device_key_limit_reached"}}', 'zh', '登录失败,请检查邮箱或密码']
] as const)('Native message %s at %s shows its sign-in copy', async (message, locale: Locale, copy) => {
  setRuntimeI18nLocale(locale)
  nativeAnswers(message)
  await managedBrowserSignIn('apex', context())
  expect($desktopOnboarding.get()).toMatchObject({
    managedSubmitting: false,
    managedError: copy,
    managedRuntimeRecovery: null
  })
})

it.each(['email', 'browser', 'deep-link'] as const)('the %s sign-in shows the device-limit copy', async kind => {
  setRuntimeI18nLocale('zh')
  const native = nativeAnswers('MANAGED_DEVICE_LIMIT_REACHED')

  if (kind === 'email') {
    await managedSignIn('fixture@example.invalid', 'fixture-password', context())
  } else if (kind === 'browser') {
    await managedBrowserSignIn('google', context())
  } else {
    await managedDeepLinkSignIn('fixture-code', context())
  }

  expect(native).toHaveBeenCalledOnce()
  expect($desktopOnboarding.get().managedError).toBe(LIMIT_ZH)
})

it('the login gate shows the device-limit notice and keeps sign-in available for after the other sign-out', async () => {
  setRuntimeI18nLocale('zh')
  const native = nativeAnswers('MANAGED_DEVICE_LIMIT_REACHED')
  render(
    <I18nProvider configClient={configClient} initialLocale="zh">
      <DesktopLoginScreen requestGateway={vi.fn() as never} />
    </I18nProvider>
  )
  await screen.findByRole('heading', { name: '开始使用' })
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await screen.findByText(LIMIT_ZH)
  expect(screen.queryByText('账户连接暂时无法确认,请重新登录重试')).toBeNull()
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
  await waitFor(() => expect(native).toHaveBeenCalledTimes(2))
})
