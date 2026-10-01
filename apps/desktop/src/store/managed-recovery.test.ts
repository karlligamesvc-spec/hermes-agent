import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getApiRequestProfile, setApiRequestProfile } from '@/api/client'

const setModelAssignment = vi.fn()
// Rest-typed so the lazy mock wrapper below can spread its args into it —
// a zero-arg implementation would fail tsc's TS2556 on the spread call.
const gatewayRequest = vi.fn((..._args: unknown[]) => Promise.resolve())
const notify = vi.fn()
const requestManagedReSignIn = vi.fn()
// hc-519: the global auth-state transitions the recovery drives.
const handleRelayAuthExpired = vi.fn()
const clearRelayAuthExpiry = vi.fn()
const isCurrent = vi.fn(() => true)
const captureScope = vi.fn<() => () => boolean>(() => isCurrent)

vi.mock('@/hermes', () => ({ setModelAssignment: (...args: unknown[]) => setModelAssignment(...args) }))
vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => ({ request: (...args: unknown[]) => gatewayRequest(...args) }) }
}))
vi.mock('@/store/notifications', () => ({ notify: (...args: unknown[]) => notify(...args) }))
vi.mock('@/store/onboarding', () => ({ requestManagedReSignIn: (...args: unknown[]) => requestManagedReSignIn(...args) }))
vi.mock('@/store/auth', () => ({
  captureManagedAuthRecoveryScope: () => captureScope(),
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
    isCurrent.mockReset().mockReturnValue(true)
    captureScope.mockReset().mockReturnValue(isCurrent)
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

  it('acknowledges an existing healthy key restored to the captured Runtime and retries once without claiming relay rejection', async () => {
    const resend = vi.fn(() => Promise.resolve())
    registerActiveTurnResend(resend)
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: false, healed: false, runtimeRestored: true,
      needsSignIn: false, probeStatus: 'ok', assignment: ASSIGNMENT }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: 'healthy-runtime', isActive: true })).toBe(true)
    expect(setModelAssignment).toHaveBeenCalledExactlyOnceWith(ASSIGNMENT)
    expect(gatewayRequest).toHaveBeenCalledExactlyOnceWith('reload.env')
    expect(resend).toHaveBeenCalledTimes(1)
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
  it('keeps temporary recovery failure separate from account expiry', async () => {
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: true, healed: false, needsSignIn: false, assignment: null }))

    expect(await recoverFromManagedRelayAuthError({ sessionId: 'transient', isActive: true })).toBe(false)
    expect(handleRelayAuthExpired).not.toHaveBeenCalled()
    expect(requestManagedReSignIn).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it.each(['ok', 'unknown', 'unreachable'] as const)('only a confirmed healthy probe lifts an old soft expiry (%s)', async probeStatus => {
    setSelfHeal(() => Promise.resolve({ ok: true, relayUnauthorized: false, healed: false, needsSignIn: false, probeStatus, assignment: null }))

    await reconcileRelayAuthState()

    expect(clearRelayAuthExpiry).toHaveBeenCalledTimes(probeStatus === 'ok' ? 1 : 0)
    expect(handleRelayAuthExpired).not.toHaveBeenCalled()
  })

  it.each([true, false])('ignores an old account reply (healed=%s)', async healed => {
    setSelfHeal(async () => {
      isCurrent.mockReturnValue(false)

      return { ok: true, relayUnauthorized: true, healed, needsSignIn: !healed, assignment: healed ? ASSIGNMENT : null }
    })

    await recoverFromManagedRelayAuthError({ sessionId: 'old-owner', isActive: true })

    expect(setModelAssignment).not.toHaveBeenCalled()
    expect(clearRelayAuthExpiry).not.toHaveBeenCalled()
    expect(handleRelayAuthExpired).not.toHaveBeenCalled()
    expect(requestManagedReSignIn).not.toHaveBeenCalled()
  })

  it('does not let a pending old-owner recovery suppress the new owner at the same entry', async () => {
    let owner = 'fixture-a'
    captureScope.mockImplementation(() => {
      const captured = owner

      return () => owner === captured
    })
    let release!: () => void
    let calls = 0
    setSelfHeal(async () => {
      calls++

      if (calls === 1) {await new Promise<void>(resolve => { release = resolve })}

      return { ok: true, relayUnauthorized: false, healed: false, needsSignIn: false, probeStatus: 'ok', assignment: null }
    })
    const previous = reconcileRelayAuthState()
    owner = 'fixture-b'
    await reconcileRelayAuthState()
    expect(calls).toBe(2)
    expect(clearRelayAuthExpiry).toHaveBeenCalledTimes(1)
    release()
    await previous
    expect(clearRelayAuthExpiry).toHaveBeenCalledTimes(1)
  })

})


it('ignores a late relay recovery from a different initiating profile before applying or resending', async () => {
  const oldProfile = getApiRequestProfile()
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => {resolve = done})
  setSelfHeal(() => pending)
  setModelAssignment.mockClear()
  gatewayRequest.mockClear()
  clearRelayAuthExpiry.mockClear()
  isCurrent.mockReturnValue(true)

  try {
    setApiRequestProfile('profile-a')
    const recovering = recoverFromManagedRelayAuthError({ sessionId: 'hc903-profile', isActive: true })
    setApiRequestProfile('profile-b')
    resolve({ ok: true, relayUnauthorized: true, healed: true, needsSignIn: false, assignment: ASSIGNMENT })
    expect(await recovering).toBe(false)
    expect(setModelAssignment).not.toHaveBeenCalled()
    expect(gatewayRequest).not.toHaveBeenCalled()
    expect(clearRelayAuthExpiry).not.toHaveBeenCalled()
  } finally {setApiRequestProfile(oldProfile)}
})
