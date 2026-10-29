/**
 * hc-1110 identity guard harness: the APEX sign-in surfaces and the places that
 * open them. The goldens beside this file were recorded with this same file on
 * fork main e495735111, before any hc-1110 code existed, so it must keep using
 * only APIs main already had.
 */
import { useStore } from '@nanostores/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'

import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { DesktopAuthGate } from '@/app/desktop-auth-gate'
import { SingleThreadAccountRow } from '@/app/single-thread/sidebar-account'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { Locale } from '@/i18n/types'
import { $authState, canMountDesktopOnboarding, type DesktopAuthState } from '@/store/auth'
import { $desktopOnboarding, type DesktopOnboardingState, type OnboardingContext } from '@/store/onboarding'

/** React's and Radix's generated ids count up per render in one test run; they are not what the guard is about. */
export function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

export const never = () => new Promise<never>(() => undefined)

/** A desktop bridge that never answers: what is on screen is exactly the seeded state. */
export function installQuietBridge(): void {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api: vi.fn(never), managed: { status: vi.fn(never) } }
  })
}

export function removeBridge(): void {
  Reflect.deleteProperty(window, 'hermesDesktop')
}

const ONBOARDING_AT_REST: DesktopOnboardingState = {
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
  managedAvailable: null,
  managedError: null,
  managedRuntimeRecovery: null,
  managedSubmitting: false,
  managedSyncing: false,
  byokFromLogin: false,
  freeTierReady: false
}

/** A signed-in, configured install, then whatever the case changes. */
export function seed(auth: Partial<DesktopAuthState> = {}, onboarding: Partial<DesktopOnboardingState> = {}): void {
  window.localStorage.clear()
  setRuntimeI18nLocale('zh')
  $desktopOnboarding.set({ ...ONBOARDING_AT_REST, ...onboarding })
  $authState.set({
    account: { email: 'kael@example.com', name: 'Kael', plan: '' },
    accountId: 'account-fixture',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in',
    ...auth
  })
}

export function Providers({ children, locale = 'zh', path }: { children: ReactNode; locale?: Locale; path?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={path ? [path] : undefined}>
        <I18nProvider configClient={null} initialLocale={locale}>
          {children}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

/** Both overlays the shell mounts for the main window, in its order and under its mount rule (wiring.tsx). */
export function Overlays({ requestGateway }: { requestGateway?: OnboardingContext['requestGateway'] }) {
  const auth = useStore($authState)
  const onboardingRequested = useStore($desktopOnboarding).requested

  return (
    <>
      <DesktopAuthGate enabled requestGateway={requestGateway ?? (vi.fn(never) as never)} />
      {canMountDesktopOnboarding(auth, onboardingRequested) && (
        <DesktopOnboardingOverlay enabled requestGateway={requestGateway ?? (vi.fn(never) as never)} />
      )}
    </>
  )
}

export async function renderOverlays(locale: Locale = 'zh'): Promise<HTMLElement> {
  setRuntimeI18nLocale(locale)

  const view = render(
    <Providers locale={locale}>
      <Overlays />
    </Providers>
  )

  await settle()

  return view.container
}

/** The account row the shell shows in every mode but single-thread product mode, with its menu open when signed in. */
export async function renderAccountPanel(): Promise<HTMLElement> {
  const view = render(
    <Providers>
      <AccountPanel />
    </Providers>
  )

  const trigger = screen.queryByRole('button', { name: '打开账户菜单: Kael' })

  if (trigger) {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    await screen.findByRole('menuitem', { name: '重新登录' })
  }

  await settle()

  return view.baseElement
}

/** The single-thread account row with its menu open. */
export async function renderSingleThreadAccountRow(): Promise<HTMLElement> {
  const view = render(
    <Providers>
      <SingleThreadAccountRow onNavigateBusiness={() => undefined} />
    </Providers>
  )

  const trigger = screen.getAllByRole('button')[0]

  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  await screen.findByRole('menuitem', { name: '重新登录' })
  await settle()

  return view.baseElement
}
