import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $notifications } from '@/store/notifications'
import { $desktopOnboarding, cancelOnboardingFlow, requestManagedReSignIn } from '@/store/onboarding'
import { $planUsage } from '@/store/plan-usage'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  mountProfile,
  profilePlan,
  renderProfile,
  runtimeNotReadyToast,
  setMode,
  signInAs,
  signInToast
} from './__identity__/account-plan/harness'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<object>()),
  getUsageAnalytics: vi.fn()
}))

/**
 * hc-1133, product mode: 个人资料 names the plan the way the account menu does, and
 * the toasts of a sign-in speak the window's language. The other two modes are
 * pinned by account-plan-identity.test.tsx.
 */

const signedOut = $authState.get()
const onboarding = $desktopOnboarding.get()

/** Every bit of text on the page, to prove a code is nowhere on it, not just not in the two places asked. */
const everyWordOn = (baseElement: Element) => baseElement.textContent ?? ''

beforeEach(() => {
  cancelOnboardingFlow()
  setRuntimeI18nLocale('zh')
  setMode(true, 'product')
})

afterEach(() => {
  cleanup()
  cancelOnboardingFlow()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('zh')
  $authState.set(signedOut)
  $desktopOnboarding.set(onboarding)
  $notifications.set([])
  $planUsage.set(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

function readsPlan(usage: unknown) {
  const planUsage = vi.fn(async () => ({ ok: true, usage }))

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { planUsage } } })

  return planUsage
}

describe('个人资料: the plan', () => {
  it.each([
    ['free', 'zh', '免费'],
    ['fast', 'zh', 'Pro'],
    ['advanced', 'zh', 'Max'],
    ['free', 'zh-hant', '免費'],
    ['fast', 'zh-hant', 'Pro'],
    ['free', 'en', 'Free'],
    ['fast', 'en', 'Pro'],
    ['advanced', 'en', 'Max']
  ] as const)('the sign-in gave %s, in %s: %s', async (code, locale, name) => {
    const { baseElement } = await renderProfile(code, locale)

    await waitFor(() => expect(profilePlan(baseElement)).toEqual({ badge: name, row: name }))
    expect(everyWordOn(baseElement)).not.toContain(code)
  })

  it.each([' fast ', 'FAST'])('a code written as %j is still Pro', async code => {
    const { baseElement } = await renderProfile(code)

    expect(profilePlan(baseElement)).toEqual({ badge: 'Pro', row: 'Pro' })
  })

  // `pro` is here on purpose: the billing package maps it to the plan now called Max, so it names nothing.
  it.each(['plus', 'pro', 'team_internal'])('a code nothing names (%s) is not shown', async code => {
    const { baseElement } = await renderProfile(code)

    await waitFor(() => expect(profilePlan(baseElement)).toEqual({ badge: null, row: '未提供' }))
    expect(everyWordOn(baseElement)).not.toContain(code)
  })

  it('no code at all: 未提供, as the page always said', async () => {
    const { baseElement } = await renderProfile('')

    expect(profilePlan(baseElement)).toEqual({ badge: null, row: '未提供' })
  })

  it('the cloud’s word wins over an older sign-in, as on the menu', async () => {
    readsPlan({ period: 'month', planCode: 'advanced', planName: '高级', usedRatio: null, weekly: null })

    const { baseElement } = await renderProfile('free')

    await waitFor(() => expect(profilePlan(baseElement)).toEqual({ badge: 'Max', row: 'Max' }))
  })

  it('a plan this build does not list: the cloud’s name for it, never the code', async () => {
    readsPlan({ period: 'month', planCode: 'team_internal', planName: '团队', usedRatio: null, weekly: null })

    const { baseElement } = await renderProfile('team_internal')

    await waitFor(() => expect(profilePlan(baseElement)).toEqual({ badge: '团队', row: '团队' }))
    expect(everyWordOn(baseElement)).not.toContain('team_internal')
  })

  it('a cloud whose name is just the code again: not shown', async () => {
    readsPlan({ period: 'month', planCode: 'team_internal', planName: 'team_internal', usedRatio: null, weekly: null })

    const { baseElement } = await renderProfile('team_internal')

    await waitFor(() => expect($planUsage.get()).not.toBeNull())
    expect(profilePlan(baseElement)).toEqual({ badge: null, row: '未提供' })
    expect(everyWordOn(baseElement)).not.toContain('team_internal')
  })

  it('reads the account’s line when the page opens', async () => {
    const planUsage = readsPlan(null)

    await renderProfile('fast')

    await waitFor(() => expect(planUsage).toHaveBeenCalledTimes(1))
  })

  it.each([
    ['switch-off', false, 'product'],
    ['developer', true, 'technical']
  ] as const)('%s reads nothing the page did not read before', async (_mode, singleThread, toolView) => {
    const planUsage = readsPlan(null)

    setMode(singleThread, toolView)
    await renderProfile('fast')

    expect(planUsage).not.toHaveBeenCalled()
  })

  // A build that can sign in gives way to the sign-in screen instead; this is the one still drawing the placeholder.
  it('no account on this build: no plan and no read', async () => {
    const planUsage = readsPlan(null)

    $authState.set({ ...signedOut, account: { email: '', name: '', plan: 'fast' }, enabled: false, status: 'signed-out' })

    const { baseElement } = await mountProfile('zh', '未登录')

    expect(profilePlan(baseElement)).toEqual({ badge: null, row: '未提供' })
    expect(planUsage).not.toHaveBeenCalled()
  })
})

describe('the toast at the end of a sign-in', () => {
  it.each(['email', 'browser', 'deep-link'] as const)('%s, in Chinese', async way => {
    expect(await signInToast(way)).toEqual([{ kind: 'success', message: 'APEX 准备好了。', title: '登录成功' }])
  })

  it('signing in again says the same', async () => {
    signInAs('fast')
    requestManagedReSignIn('')

    expect(await signInToast()).toEqual([{ kind: 'success', message: 'APEX 准备好了。', title: '登录成功' }])
  })

  it.each([
    ['zh-hant', { kind: 'success', message: 'APEX 準備好了。', title: '登入成功' }],
    ['en', { kind: 'success', message: 'APEX connected.', title: 'APEX is ready' }],
    ['ja', { kind: 'success', message: 'APEX connected.', title: 'APEX is ready' }],
    ['ar', { kind: 'success', message: 'APEX connected.', title: 'APEX is ready' }]
  ] as const)('%s', async (locale, toast) => {
    setRuntimeI18nLocale(locale)

    expect(await signInToast()).toEqual([toast])
  })
})

describe('the toast when the engine does not answer as the gateway reopens', () => {
  it.each([
    [
      'zh',
      'APEX 还没准备好',
      '启动时没能确认后台在运行。连上之前，部分功能可能用不了。'
    ],
    ['zh-hant', 'APEX 還沒準備好', '啟動時沒能確認背景服務在執行。連上之前，部分功能可能用不了。'],
    [
      'en',
      'Runtime not ready',
      'Hermes Desktop could not verify the running backend on startup. Some features may be unavailable until the gateway is reachable.'
    ]
  ] as const)('%s', async (locale, title, message) => {
    setRuntimeI18nLocale(locale)

    expect(await runtimeNotReadyToast()).toEqual([{ kind: 'error', message, title }])
  })
})
