import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopManagedStatus } from '@/global'

import {
  $authState,
  clearRelayAuthExpiry,
  handleAuthGate,
  handleRelayAuthExpired,
  markManagedUnavailable,
  markSignedIn,
  refreshAuthStatus,
  signOutAccount
} from './auth'

function status(overrides: Partial<DesktopManagedStatus> = {}): DesktopManagedStatus {
  return {
    baseUrl: 'https://apex-nodes.com/relay/v1',
    email: '',
    enabled: true,
    model: 'deepseek-v4-pro',
    modelDisplay: 'deepseek-v4-pro-APEX',
    name: '',
    plan: '',
    provider: 'custom',
    signedIn: false,
    ...overrides
  }
}

function installManagedMock(managed: Record<string, unknown>) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { managed }
  })
}

// Reset the atom + storage before each test so cases don't bleed. The atom is a
// module singleton, so we set it back to the pristine (never-checked) shape.
function resetAuth() {
  window.localStorage.clear()
  $authState.set({
    account: { email: '', name: '', plan: '' },
    enabled: null,
    gateReason: null,
    loginTruth: true,
    status: 'checking'
  })
}

beforeEach(() => {
  resetAuth()
})

afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error — tearing down the injected global between tests.
  delete window.hermesDesktop
})

describe('refreshAuthStatus', () => {
  it('signs the user in and surfaces the account when the relay key is on disk', async () => {
    installManagedMock({ status: vi.fn().mockResolvedValue(status({ signedIn: true, email: 'jane@apex-nodes.com', plan: 'pro' })) })

    await refreshAuthStatus()

    const state = $authState.get()
    expect(state.status).toBe('signed-in')
    expect(state.enabled).toBe(true)
    expect(state.account).toEqual({ email: 'jane@apex-nodes.com', name: '', plan: 'pro' })
  })

  it('gates to signed-out when managed is enabled but no key is present', async () => {
    installManagedMock({ status: vi.fn().mockResolvedValue(status({ signedIn: false })) })

    await refreshAuthStatus()

    expect($authState.get().status).toBe('signed-out')
  })

  it('does not gate on a managed-disabled build (chat flows through)', async () => {
    installManagedMock({ status: vi.fn().mockResolvedValue(status({ enabled: false })) })

    await refreshAuthStatus()

    const state = $authState.get()
    expect(state.enabled).toBe(false)
    expect(state.status).toBe('signed-in')
  })

  it('treats a missing desktop bridge as managed-disabled (dev preview)', async () => {
    // No window.hermesDesktop at all.
    await refreshAuthStatus()

    expect($authState.get().enabled).toBe(false)
  })

  it('keeps a cached signed-in user through a transient status() failure', async () => {
    window.localStorage.setItem('apexnodes-desktop-signed-in-v1', '1')
    installManagedMock({ status: vi.fn().mockRejectedValue(new Error('ipc down')) })

    await refreshAuthStatus()

    expect($authState.get().status).toBe('signed-in')
  })

  it('does not downgrade a disabled account to signed-out on re-check', async () => {
    // Account was disabled mid-session…
    handleAuthGate({ reason: 'account_disabled', statusCode: 403 })
    expect($authState.get().status).toBe('disabled')

    // …a later status() (still no key) must preserve the disabled message.
    installManagedMock({ status: vi.fn().mockResolvedValue(status({ signedIn: false })) })
    await refreshAuthStatus()

    expect($authState.get().status).toBe('disabled')
  })
})

describe('handleAuthGate (continuous gate)', () => {
  it('flips to signed-out on a 401 (login lost)', () => {
    $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in' })

    handleAuthGate({ reason: 'unauthorized', statusCode: 401 })

    const state = $authState.get()
    expect(state.status).toBe('signed-out')
    expect(state.gateReason).toBe('unauthorized')
    expect(window.localStorage.getItem('apexnodes-desktop-signed-in-v1')).toBeNull()
  })

  it('flips to disabled on a 403 account_disabled', () => {
    $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in' })

    handleAuthGate({ reason: 'account_disabled', statusCode: 403 })

    expect($authState.get().status).toBe('disabled')
  })

  it('is a no-op on a managed-disabled build', () => {
    $authState.set({ ...$authState.get(), enabled: false, status: 'signed-in' })

    handleAuthGate({ reason: 'unauthorized', statusCode: 401 })

    expect($authState.get().status).toBe('signed-in')
  })
})

describe('markSignedIn / markManagedUnavailable / signOutAccount', () => {
  it('markSignedIn unblocks chat and caches the session', () => {
    installManagedMock({ status: vi.fn().mockResolvedValue(status({ signedIn: true })) })

    markSignedIn({ email: 'j@apex-nodes.com' })

    expect($authState.get().status).toBe('signed-in')
    expect(window.localStorage.getItem('apexnodes-desktop-signed-in-v1')).toBe('1')
  })

  it('markManagedUnavailable drops the account gate (BYOK fallback)', () => {
    $authState.set({ ...$authState.get(), enabled: true, status: 'signed-out' })

    markManagedUnavailable()

    const state = $authState.get()
    expect(state.enabled).toBe(false)
    expect(state.status).toBe('signed-in')
  })

  it('signOutAccount clears the relay key and returns to signed-out', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true })
    installManagedMock({ signOut })
    $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in' })

    await signOutAccount()

    expect(signOut).toHaveBeenCalledOnce()
    expect($authState.get().status).toBe('signed-out')
    expect($authState.get().gateReason).toBeNull()
  })
})

// hc-519 — relay-key validity as the single source of truth.
describe('handleRelayAuthExpired / clearRelayAuthExpiry', () => {
  it('degrades a signed-in account to expired, keeping the identity for display', () => {
    window.localStorage.setItem('apexnodes-desktop-signed-in-v1', '1')
    $authState.set({
      ...$authState.get(),
      account: { email: 'jane@apex-nodes.com', name: 'Jane', plan: 'pro' },
      enabled: true,
      status: 'signed-in'
    })

    handleRelayAuthExpired()

    const state = $authState.get()
    expect(state.status).toBe('expired')
    expect(state.gateReason).toBe('unauthorized')
    // Identity is retained so the degraded card can show who was signed in.
    expect(state.account).toEqual({ email: 'jane@apex-nodes.com', name: 'Jane', plan: 'pro' })
    // The cached signed-in flag is cleared so a reload doesn't flash "signed-in".
    expect(window.localStorage.getItem('apexnodes-desktop-signed-in-v1')).toBeNull()
  })

  it('is a no-op when the rollback switch (loginTruth) is off — hc-511 behavior', () => {
    $authState.set({ ...$authState.get(), enabled: true, loginTruth: false, status: 'signed-in' })

    handleRelayAuthExpired()

    expect($authState.get().status).toBe('signed-in')
  })

  it('is a no-op on a managed-disabled build', () => {
    $authState.set({ ...$authState.get(), enabled: false, status: 'signed-in' })

    handleRelayAuthExpired()

    expect($authState.get().status).toBe('signed-in')
  })

  it('clearRelayAuthExpiry lifts expired back to signed-in', () => {
    $authState.set({ ...$authState.get(), enabled: true, gateReason: 'unauthorized', status: 'expired' })

    clearRelayAuthExpiry()

    const state = $authState.get()
    expect(state.status).toBe('signed-in')
    expect(state.gateReason).toBeNull()
    expect(window.localStorage.getItem('apexnodes-desktop-signed-in-v1')).toBe('1')
  })

  it('clearRelayAuthExpiry never manufactures a signed-in state when not expired', () => {
    $authState.set({ ...$authState.get(), enabled: true, status: 'signed-out' })

    clearRelayAuthExpiry()

    expect($authState.get().status).toBe('signed-out')
  })

  it('refreshAuthStatus does NOT launder a stale key back to signed-in while expired', async () => {
    // Relay expiry tripped this session; the key file is still on disk, so a
    // re-check reports signedIn=true — but that key is exactly the dead one.
    $authState.set({ ...$authState.get(), enabled: true, gateReason: 'unauthorized', status: 'expired' })
    installManagedMock({
      status: vi.fn().mockResolvedValue(status({ signedIn: true, email: 'jane@apex-nodes.com' }))
    })

    await refreshAuthStatus()

    const state = $authState.get()
    expect(state.status).toBe('expired')
    // Identity still refreshes so the degraded card stays accurate.
    expect(state.account.email).toBe('jane@apex-nodes.com')
  })

  it('refreshAuthStatus mirrors the loginTruth rollback switch from status()', async () => {
    installManagedMock({ status: vi.fn().mockResolvedValue(status({ signedIn: true, loginStateTruth: false })) })

    await refreshAuthStatus()

    expect($authState.get().loginTruth).toBe(false)
  })
})
