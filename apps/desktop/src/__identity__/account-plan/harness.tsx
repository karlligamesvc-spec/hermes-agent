/**
 * hc-1133 identity guard harness: 个人资料 and the toasts of a sign-in, driven for
 * real. It must keep using only APIs main already had: the same file recorded the
 * goldens beside it on fork main bb742c3fbe, before any hc-1133 code existed.
 *
 * A test using it mocks `@/hermes` so that `getUsageAnalytics` is a `vi.fn()`.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, vi } from 'vitest'

import { ProfileStatsView } from '@/app/profile'
import { getUsageAnalytics } from '@/hermes'
import { I18nProvider, type Locale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $notifications } from '@/store/notifications'
import {
  $desktopOnboarding,
  cancelOnboardingFlow,
  managedBrowserSignIn,
  managedDeepLinkSignIn,
  managedSignIn,
  type OnboardingContext,
  refreshOnboarding
} from '@/store/onboarding'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import type { AnalyticsResponse } from '@/types/hermes'

const NO_SESSIONS = {
  by_model: [],
  daily: [],
  period_days: 365,
  skills: { by_skill: [], summary: { distinct_skills_used: 0, total_skill_actions: 0, total_skill_loads: 0 } },
  totals: { total_api_calls: 0, total_estimated_cost: 0, total_input: 0, total_output: 0, total_sessions: 0 }
} as unknown as AnalyticsResponse

const noop = () => undefined

export function setMode(singleThread: boolean, toolView: 'product' | 'technical'): void {
  // Tool view first: switch-on-then-developer would pass through product mode on the way.
  setToolViewMode(toolView)
  setSingleThreadFlagForTest(singleThread)
}

export function signInAs(plan: string): void {
  $authState.set({
    account: { email: 'kael@example.com', name: 'Kael', plan },
    accountId: 'acct-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
}

/** 个人资料 with nothing in its usage block: only the account's lines change from one render to the next. */
export async function renderProfile(plan: string, locale: Locale = 'zh') {
  signInAs(plan)
  vi.mocked(getUsageAnalytics).mockResolvedValue(NO_SESSIONS)

  const view = render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale={locale}>
        <ProfileStatsView onClose={noop} onOpenSettings={noop} />
      </I18nProvider>
    </MemoryRouter>
  )

  await screen.findByRole('heading', { name: 'Kael' })
  await vi.waitFor(() => expect(view.baseElement.querySelector('.p5-profile-section')).not.toBeNull())

  return view
}

/** What the page says about the plan: the badge in the header and the 方案 row under the email. */
export function profilePlan(baseElement: Element) {
  const [, row] = baseElement.querySelectorAll('.p5-profile-kv-value')

  return { badge: baseElement.querySelector('.p5-profile-plan')?.textContent ?? null, row: row?.textContent ?? null }
}

function shownToasts() {
  return $notifications.get().map(({ kind, message, title }) => ({ kind, message, title }))
}

export type SignInWay = 'browser' | 'deep-link' | 'email'

/** The toast a sign-in that reaches the end leaves behind: every sign-in, first or again, ends the same way. */
export async function signInToast(way: SignInWay = 'email') {
  $notifications.set([])

  const native = vi.fn(async () => ({
    assignment: {
      api_key: 'fixture-key',
      base_url: 'http://fixture.invalid/v1',
      model: 'fixture-model',
      provider: 'custom',
      scope: 'main'
    },
    hasRelayKey: true,
    ok: true
  }))

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      api: vi.fn(async () => ({ ok: true })),
      managed: {
        browserSignIn: native,
        deepLinkSignIn: native,
        signIn: native,
        status: vi.fn(async () => ({
          accountId: 'acct-1',
          email: 'kael@example.com',
          enabled: true,
          name: 'Kael',
          signedIn: true
        }))
      }
    }
  })

  const context = {
    onCompleted: noop,
    requestGateway: vi.fn(async (method: string) =>
      method === 'setup.status' ? { provider_configured: true } : { ok: true }
    ) as never
  }

  if (way === 'email') {
    await managedSignIn('kael@example.com', 'fixture-password', context)
  } else if (way === 'browser') {
    await managedBrowserSignIn('apex', context)
  } else {
    await managedDeepLinkSignIn('fixture-code', context)
  }

  cancelOnboardingFlow()

  return shownToasts()
}

/** The toast when the engine does not answer as the gateway reopens: at launch, and after a sign-out restarts it. */
export async function runtimeNotReadyToast() {
  $notifications.set([])
  $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true, manual: false, requested: false })
  Reflect.deleteProperty(window, 'hermesDesktop')

  const requestGateway: OnboardingContext['requestGateway'] = async method => {
    throw new Error(`request timed out: ${method}`)
  }

  await refreshOnboarding({ requestGateway })

  return shownToasts()
}
