import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopAuthGate } from '@/app/desktop-auth-gate'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { I18nProvider } from '@/i18n/context'
import { $authState, canMountDesktopOnboarding } from '@/store/auth'
import { $desktopOnboarding, type OnboardingContext } from '@/store/onboarding'

// hc-589 leg 8c — the first-run route, sampled tick by tick.
//
// Kael's sandbox reached a perfectly configured terminal state (config.yaml
// carrying the relay base_url, runtime_check ok) in ~16 seconds and STILL asked
// him to choose an LLM somewhere inside that window. No end-state assertion can
// see that; only walking the timeline can. So this file drives the real stores
// through the real electron round-trips on a fake clock and inspects the
// rendered document at every step.
//
// The gap an end-state view misses: "onboarding finished" and "the account gate
// opened" are two different events. applyManagedSignInResult only marks
// onboarding done when the runtime is ALREADY serving the new key, while
// DesktopAuthGate re-probes on every gateway (re-)open — and the relay key hits
// disk during sign-in. A gateway reconnect (which a fresh install does after
// reload.env) therefore flips the window to signed-in while onboarding is still
// undecided (configured === null), and everything the user sees in that window
// is drawn by the onboarding overlay with nothing resolved yet.

const RELAY_BASE_URL = 'https://apex-nodes.com/relay/v1'
// Kael's measured window: sandbox start → config.yaml on disk.
const RUNTIME_READY_AT_MS = 16_000

// Every string that means "we are asking this user to choose an LLM": the BYOK
// header, both faces of the picker (OAuth rows and the key form), and the
// model-confirm dialog. A zero-key user may see none of them, ever.
const ASKS_USER_TO_CHOOSE = [
  '开始设置 APEX',
  '连接模型提供方',
  '我有 API 密钥',
  '粘贴 API 密钥',
  '获取密钥',
  'Fireworks AI',
  'Nous Portal',
  '默认模型'
]

// innerHTML rather than text queries: it catches placeholders and aria-labels
// too, so a card screen cannot hide behind an attribute.
const askedToChoose = (window: HTMLElement) => ASKS_USER_TO_CHOOSE.filter(marker => window.innerHTML.includes(marker))

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The window as wiring.tsx assembles it: the auth gate blocks everything until
// the user is signed in, and onboarding mounts only once the gate lets them
// through. `gatewayOpen` is the prop both surfaces gate on (gatewayState ===
// 'open'), so toggling it reproduces a reconnect.
function FirstRunWindow({
  gatewayOpen,
  requestGateway
}: {
  gatewayOpen: boolean
  requestGateway: OnboardingContext['requestGateway']
}) {
  const auth = useStore($authState)
  const onboarding = useStore($desktopOnboarding)

  return (
    <>
      <DesktopAuthGate enabled={gatewayOpen} requestGateway={requestGateway} />
      {canMountDesktopOnboarding(auth, onboarding.requested) && (
        <DesktopOnboardingOverlay enabled={gatewayOpen} requestGateway={requestGateway} />
      )}
    </>
  )
}

function installBridge(options: { statusLatencyMs?: number } = {}) {
  const statusLatencyMs = options.statusLatencyMs ?? 120
  const state = { elapsed: 0, relayKey: false, statusFails: false }

  const requestGateway = (async (method: string) => {
    if (method === 'setup.status') {
      // The managed provider is in config from the moment the assignment is
      // written, which is exactly why this disagrees with the runtime check for
      // as long as the backend hasn't reloaded.
      return { provider_configured: true }
    }

    if (method === 'setup.runtime_check') {
      return state.elapsed >= RUNTIME_READY_AT_MS
        ? { ok: true, provider: 'custom', model: null, source: 'pool:custom:apex-nodes.com' }
        : { ok: false, error: 'Selected runtime is not available.' }
    }

    return { ok: true }
  }) as never

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      api: async ({ path }: { path: string }) => {
        if (path === '/api/providers/oauth') {
          return {
            providers: [{ cli_command: '', docs_url: '', flow: 'pkce', id: 'nous', name: 'Nous Portal', status: {} }]
          }
        }

        return { providers: [], ok: true }
      },
      managed: {
        status: async () => {
          // An IPC round-trip against a main process that is busy installing
          // skills and spawning the backend: it resolves late, and under load it
          // can fail outright.
          await sleep(statusLatencyMs)

          if (state.statusFails) {
            throw new Error('managed status unavailable')
          }

          return {
            baseUrl: RELAY_BASE_URL,
            email: 'kael@example.com',
            enabled: true,
            hasToken: true,
            loginStateTruth: true,
            model: 'apex',
            modelDisplay: 'apex',
            name: 'Kael',
            plan: 'pro',
            provider: 'custom',
            signedIn: state.relayKey
          }
        },
        browserSignIn: async () => {
          await sleep(1200)
          // Electron persists the provisioned key BEFORE the renderer applies
          // the assignment — from here on every status() reads signedIn.
          state.relayKey = true

          return {
            ok: true,
            hasRelayKey: true,
            assignment: {
              scope: 'main',
              provider: 'custom',
              model: 'apex',
              base_url: RELAY_BASE_URL,
              api_key: 'relay-key'
            }
          }
        },
        signOut: async () => ({ ok: true })
      }
    }
  })

  return { requestGateway, state }
}

const freshInstall = () => {
  window.localStorage.clear()
  $desktopOnboarding.set({
    configured: null,
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
    managedSubmitting: false,
    managedSyncing: false,
    byokFromLogin: false
  })
  $authState.set({
    account: { email: '', name: '', plan: '' },
    enabled: null,
    gateReason: null,
    loginTruth: true,
    status: 'checking'
  })
}

describe('first run: a managed sign-in never passes through a "choose an LLM" screen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    freshInstall()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    freshInstall()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  const advance = async (ms: number, state: { elapsed: number }) => {
    state.elapsed += ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  // Walk the window in 50ms steps — fine enough that a surface which only lives
  // for one probe round-trip (the case a coarse grid steps straight over) still
  // gets caught. Reports every tick that asked the user to choose, with the
  // offending strings and when they appeared.
  const walk = async (
    window: HTMLElement,
    state: { elapsed: number },
    untilMs: number
  ): Promise<Array<{ at: number; saw: string[] }>> => {
    const seen: Array<{ at: number; saw: string[] }> = []

    while (state.elapsed < untilMs) {
      await advance(50, state)
      const saw = askedToChoose(window)

      if (saw.length > 0) {
        seen.push({ at: state.elapsed, saw })
      }
    }

    return seen
  }

  it('holds the window from sign-in to runtime-ready, across a gateway reconnect', async () => {
    const { requestGateway, state } = installBridge()

    const view = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <FirstRunWindow gatewayOpen requestGateway={requestGateway} />
      </I18nProvider>
    )

    // Env ready → the gate probes → not signed in → our login screen.
    await advance(500, state)
    expect(screen.getByRole('heading', { name: '开始使用' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
    })

    // Browser round-trip lands the relay key; the assignment is written, but the
    // backend is still reloading, so onboarding does NOT complete here.
    await advance(2000, state)
    expect(state.relayKey).toBe(true)
    expect($desktopOnboarding.get().configured).not.toBe(true)

    // The gateway reconnects after reload.env. This is what flips the window to
    // signed-in with onboarding still undecided — the exact state Kael was in.
    view.rerender(
      <I18nProvider configClient={null} initialLocale="zh">
        <FirstRunWindow gatewayOpen={false} requestGateway={requestGateway} />
      </I18nProvider>
    )
    await advance(50, state)
    view.rerender(
      <I18nProvider configClient={null} initialLocale="zh">
        <FirstRunWindow gatewayOpen requestGateway={requestGateway} />
      </I18nProvider>
    )

    // Sampling starts on the very next frame, so the surfaces that live for only
    // one probe round-trip are inside the walk, not before it.
    const offences = await walk(view.container, state, RUNTIME_READY_AT_MS + 4000)

    expect(offences).toEqual([])
    expect($authState.get().status).toBe('signed-in')
    // …and it ends in the app, not on a waiting screen.
    expect($desktopOnboarding.get().configured).toBe(true)
    expect(view.container.textContent).toBe('')
  })

  it('holds the window even when the managed probe itself is failing', async () => {
    // Same window, but the main process is too busy to answer managed:status.
    // An unanswered probe is not permission to ask a zero-key user for an API
    // key — absence of a signal must read as "still managed", not as BYOK.
    const { requestGateway, state } = installBridge()

    const view = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <FirstRunWindow gatewayOpen requestGateway={requestGateway} />
      </I18nProvider>
    )

    await advance(500, state)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))
    })
    await advance(2000, state)

    // Signed in per the key on disk, then the probe goes dark.
    act(() => {
      $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in' })
    })
    state.statusFails = true

    const offences = await walk(view.container, state, RUNTIME_READY_AT_MS + 4000)

    expect(offences).toEqual([])
  })
})
