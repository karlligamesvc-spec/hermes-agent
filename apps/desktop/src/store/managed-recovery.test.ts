import { beforeEach, describe, expect, it, vi } from 'vitest'

const setModelAssignment = vi.fn()
// Rest-typed so the lazy mock wrapper below can spread its args into it —
// a zero-arg implementation would fail tsc's TS2556 on the spread call.
const gatewayRequest = vi.fn((..._args: unknown[]) => Promise.resolve())
const notify = vi.fn()
const requestManagedReSignIn = vi.fn()
// hc-519: the global auth-state transitions the recovery drives.
const handleRelayAuthExpired = vi.fn()
const clearRelayAuthExpiry = vi.fn()

vi.mock('@/hermes', () => ({ setModelAssignment: (...args: unknown[]) => setModelAssignment(...args) }))
vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => ({ request: (...args: unknown[]) => gatewayRequest(...args) }) }
}))
vi.mock('@/store/notifications', () => ({ notify: (...args: unknown[]) => notify(...args) }))
vi.mock('@/store/onboarding', () => ({ requestManagedReSignIn: (...args: unknown[]) => requestManagedReSignIn(...args) }))
vi.mock('@/store/auth', () => ({
  handleRelayAuthExpired: (...args: unknown[]) => handleRelayAuthExpired(...args),
  clearRelayAuthExpiry: (...args: unknown[]) => clearRelayAuthExpiry(...args)
}))
vi.mock('@/i18n', () => ({ translateNow: (key: string) => key }))

import {
  isManagedRelayAuthError,
  reconcileRelayAuthState,
  recoverFromManagedRelayAuthError,
  registerActiveTurnResend
} from './managed-recovery'

const ASSIGNMENT = {
  api_key: 'sk-fresh',
  base_url: 'https://apex-nodes.com/relay/v1',
  model: 'deepseek-v4-pro',
  provider: 'custom',
  scope: 'main' as const
}

function setSelfHeal(fn: (() => unknown) | null) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = fn ? { managed: { selfHeal: fn } } : {}
}

describe('isManagedRelayAuthError', () => {
  it.each([
    [{ code: 'auth' }, true],
    [{ code: 'auth', status_code: 401 }, true],
    [{ status_code: 401 }, true],
    [{ status_code: 403 }, true],
    [{ code: 'client', status_code: 400 }, false],
    [{ status_code: 503 }, false],
    [{ message: 'boom' }, false],
    [undefined, false]
  ])('classifies %o as %s', (payload, expected) => {
    expect(isManagedRelayAuthError(payload)).toBe(expected)
  })
})

describe('recoverFromManagedRelayAuthError', () => {
  beforeEach(() => {
    setModelAssignment.mockReset()
    gatewayRequest.mockClear()
    notify.mockReset()
    requestManagedReSignIn.mockReset()
    handleRelayAuthExpired.mockReset()
    clearRelayAuthExpiry.mockReset()
    registerActiveTurnResend(null)
    setSelfHeal(null)
  })

  it('declines (returns false) when there is no desktop self-heal bridge', async () => {
    setSelfHeal(null)
    expect(await recoverFromManagedRelayAuthError({ sessionId: 's1', isActive: true })).toBe(false)
  })

  it('declines when the relay accepted the key (not a managed-relay auth problem)', async () => {
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: false, healed: false, needsSignIn: false, assignment: null }))
    expect(await recoverFromManagedRelayAuthError({ sessionId: 's1', isActive: true })).toBe(false)
    expect(setModelAssignment).not.toHaveBeenCalled()
    expect(requestManagedReSignIn).not.toHaveBeenCalled()
  })

  it('applies the fresh key and retries once when healed on the active turn', async () => {
    const resend = vi.fn(() => Promise.resolve())
    registerActiveTurnResend(resend)
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: true, healed: true, needsSignIn: false, assignment: ASSIGNMENT }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: 's1', isActive: true })).toBe(true)
    expect(setModelAssignment).toHaveBeenCalledWith(ASSIGNMENT)
    expect(gatewayRequest).toHaveBeenCalledWith('reload.env')
    expect(resend).toHaveBeenCalledTimes(1)
    // hc-519: a heal lifts any global 'expired' degrade back to signed-in.
    expect(clearRelayAuthExpiry).toHaveBeenCalledTimes(1)
    expect(handleRelayAuthExpired).not.toHaveBeenCalled()
    expect(requestManagedReSignIn).not.toHaveBeenCalled()
  })

  it('heals but does not auto-resend a background (non-active) turn', async () => {
    const resend = vi.fn(() => Promise.resolve())
    registerActiveTurnResend(resend)
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: true, healed: true, needsSignIn: false, assignment: ASSIGNMENT }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: 's2', isActive: false })).toBe(true)
    expect(setModelAssignment).toHaveBeenCalledWith(ASSIGNMENT)
    expect(resend).not.toHaveBeenCalled()
  })

  it('routes to re-sign-in AND degrades the global state when recovery is impossible', async () => {
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: true, healed: false, needsSignIn: true, assignment: null }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: 's1', isActive: true })).toBe(true)
    // hc-519: the account card degrades AND the send path pops the sign-in flow.
    expect(handleRelayAuthExpired).toHaveBeenCalledTimes(1)
    expect(requestManagedReSignIn).toHaveBeenCalledTimes(1)
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('declines when self-heal throws so the generic error UI still fires', async () => {
    setSelfHeal(() => Promise.reject(new Error('ipc down')))
    expect(await recoverFromManagedRelayAuthError({ sessionId: 's1', isActive: true })).toBe(false)
  })

  // hc-519: the startup / catalog reconcile path (silentHeal) — no user turn.
  it('silently heals on reconcile: restores state, no toast, no resend', async () => {
    const resend = vi.fn(() => Promise.resolve())
    registerActiveTurnResend(resend)
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: true, healed: true, needsSignIn: false, assignment: ASSIGNMENT }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: null, isActive: false, silentHeal: true })).toBe(true)
    expect(setModelAssignment).toHaveBeenCalledWith(ASSIGNMENT)
    expect(clearRelayAuthExpiry).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
    expect(resend).not.toHaveBeenCalled()
  })

  it('degrades quietly on reconcile when unhealable — card guides, no modal/toast', async () => {
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: true, healed: false, needsSignIn: true, assignment: null }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: null, isActive: false, silentHeal: true })).toBe(true)
    expect(handleRelayAuthExpired).toHaveBeenCalledTimes(1)
    // The background reconcile leaves the account card as the re-sign-in guide.
    expect(requestManagedReSignIn).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('reconcileRelayAuthState is a no-op when the relay still accepts the key', async () => {
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: false, healed: false, needsSignIn: false, assignment: null }))

    await reconcileRelayAuthState()

    expect(handleRelayAuthExpired).not.toHaveBeenCalled()
    expect(clearRelayAuthExpiry).not.toHaveBeenCalled()
    expect(requestManagedReSignIn).not.toHaveBeenCalled()
  })
})
