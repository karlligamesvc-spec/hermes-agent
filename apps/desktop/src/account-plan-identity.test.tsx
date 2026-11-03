// First: the recording time zone, before any app module or fixture.
import './__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $notifications } from '@/store/notifications'
import { $desktopOnboarding, cancelOnboardingFlow } from '@/store/onboarding'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  profilePlan,
  renderProfile,
  runtimeNotReadyToast,
  setMode,
  signInToast
} from './__identity__/account-plan/harness'
import { normalized } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<object>()),
  getUsageAnalytics: vi.fn()
}))

/**
 * hc-1133 identity guard (hard rule 11): the plan's name on 个人资料 and the
 * Chinese sign-in toasts exist only in single-thread product mode.
 *
 * The goldens under `__identity__/account-plan/` were recorded on fork main
 * bb742c3fbe with the same harness, before any hc-1133 code existed: with
 * single_thread off and in developer mode the page shows the code the sign-in
 * gave, and the toasts stay in English whatever the window's language.
 */

const GOLDEN = './__identity__/account-plan'

const signedOut = $authState.get()
const onboarding = $desktopOnboarding.get()

beforeEach(() => {
  cancelOnboardingFlow()
  setRuntimeI18nLocale('zh')
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
  Reflect.deleteProperty(window, 'hermesDesktop')
})

afterAll(restoreRecordingTimeZone)

describe.each([
  ['switch-off', false, 'product'],
  ['developer', true, 'technical']
] as const)('%s: nothing of hc-1133 reaches these', (mode, singleThread, toolView) => {
  it('个人资料 draws the page it always drew', async () => {
    setMode(singleThread, toolView)

    const { baseElement } = await renderProfile('fast')

    await expect(normalized(baseElement.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/profile-${mode}.html`)
  })

  it('个人资料 shows the code the sign-in gave, whichever it is', async () => {
    setMode(singleThread, toolView)

    const shown: Record<string, unknown> = {}

    for (const plan of ['free', 'fast', 'advanced', 'plus', 'pro', '']) {
      const { baseElement, unmount } = await renderProfile(plan)

      shown[plan || '(none)'] = profilePlan(baseElement)
      unmount()
    }

    await expect(JSON.stringify(shown, null, 2) + '\n').toMatchFileSnapshot(`${GOLDEN}/profile-plans-${mode}.json`)
  })

  it('the toasts stay as they are in every language', async () => {
    setMode(singleThread, toolView)

    const shown: Record<string, unknown> = {}

    for (const locale of ['zh', 'zh-hant', 'en', 'ja'] as const) {
      setRuntimeI18nLocale(locale)
      shown[locale] = { runtimeNotReady: await runtimeNotReadyToast(), signedIn: await signInToast() }
    }

    await expect(JSON.stringify(shown, null, 2) + '\n').toMatchFileSnapshot(`${GOLDEN}/toasts-${mode}.json`)
  })
})
