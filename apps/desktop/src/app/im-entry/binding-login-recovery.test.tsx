import { useStore } from '@nanostores/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { I18nProvider } from '@/i18n'
import { $authState, canMountDesktopOnboarding } from '@/store/auth'
import { $desktopOnboarding, cancelOnboardingFlow } from '@/store/onboarding'

import { ImEntryBindingDialog } from './binding-dialog'

function BindingWindow({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(true)
  const auth = useStore($authState)
  const onboarding = useStore($desktopOnboarding)

  return <>
    <ImEntryBindingDialog channelId={channelId} onOpenChange={setOpen} open={open} />
    {canMountDesktopOnboarding(auth, onboarding.requested) &&
      <DesktopOnboardingOverlay enabled requestGateway={async () => ({ provider_configured: true }) as never} />}
  </>
}

beforeEach(() => {
  window.localStorage.clear()
  cancelOnboardingFlow()
  $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in', accountId: 'owner',
    account: { email: 'user@example.invalid', name: 'User', plan: '' } })
  $desktopOnboarding.set({ ...$desktopOnboarding.get(), requested: false, configured: true,
    managedAvailable: false, firstRunSkipped: true, managedError: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // @ts-expect-error test bridge cleanup
  delete window.hermesDesktop
})

it.each(['weixin', 'feishu'])('closes the expired %s binding and opens managed sign-in without clearing the account', async channelId => {
  const issue = vi.fn().mockResolvedValue({ ok: false, needsSignIn: true, message: 'SESSION_EXPIRED' })
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { imEntry: { weixinIssue: issue, feishuIssue: issue } } })
  render(<I18nProvider configClient={null} initialLocale="zh"><BindingWindow channelId={channelId} /></I18nProvider>)
  await screen.findByText('登录已过期，请重新登录后再连接。')
  fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
  await screen.findByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')
  expect(screen.queryByRole('dialog', { name: /连接(微信|飞书)/ })).toBeNull()
  expect($authState.get().status).toBe('signed-in')
  expect($authState.get().accountId).toBe('owner')
  expect(issue).toHaveBeenCalledOnce()
})

it.each(['weixin', 'feishu'])('keeps a transient %s failure retryable without classifying it as expired', async channelId => {
  const issue = vi.fn().mockResolvedValue({ ok: false, message: 'REQUEST_FAILED' })
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { imEntry: { weixinIssue: issue, feishuIssue: issue } } })
  render(<I18nProvider configClient={null} initialLocale="zh"><BindingWindow channelId={channelId} /></I18nProvider>)
  await screen.findByRole('button', { name: '重试' })
  expect(screen.queryByRole('button', { name: '重新登录' })).toBeNull()
  expect($desktopOnboarding.get().requested).toBe(false)
})
