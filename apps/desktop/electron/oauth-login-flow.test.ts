/**
 * hc-919 C1 (sign-in half): only a CONFIRMED sign-in may release the remote
 * reauth latch (#95701), and every confirmed sign-in must.
 *
 * The hc-844 merge kept the native release but dropped the cookie one
 * (upstream 22751c8fd9). The boot-failure overlay's Sign in reloads straight
 * after a cookie login for a plain remote gateway, so with the latch still set
 * the reloaded boot was held on the stale "session expired" error.
 *
 * Composes the real token coordinator, so supersession runs through the same
 * login epochs main.ts uses.
 */
import { describe, expect, it } from 'vitest'

import { normalizeRemoteBaseUrl } from './connection-config'
import { createNativeAccessTokenCoordinator, NativeAuthChangedError } from './native-access-token'
import type { NativeTokenSet } from './native-oauth'
import { type OauthLoginFlowDeps, runOauthLoginFlow } from './oauth-login-flow'

const GATEWAY = 'https://gw.test'
const NATIVE_STATUS = { auth_required: true, auth_flows: ['native_pkce'] }
const EMBEDDED_STATUS = { auth_required: true, auth_flows: [] }

const tokens: NativeTokenSet = {
  accessToken: 'at-new',
  refreshToken: 'rt-new',
  expiresAt: 4_000_000_000,
  provider: 'github',
  userId: 'u1'
}

function harness(overrides: Partial<OauthLoginFlowDeps> & { status: unknown }) {
  const store = new Map<string, NativeTokenSet>([[GATEWAY, { ...tokens, accessToken: 'at-old' }]])
  const state = { latchReleases: 0, windowsOpened: 0 }

  const coordinator = createNativeAccessTokenCoordinator({
    normalizeBaseUrl: normalizeRemoteBaseUrl,
    tokenNeedsRefresh: () => false,
    loadTokens: host => store.get(host) ?? null,
    storeTokens: (host, value) => {
      store.set(host, value)
    },
    clearTokens: host => {
      store.delete(host)
    },
    isRefreshAuthRejection: () => false,
    refreshTokens: async () => {
      throw new Error('no refresh in this test')
    }
  })

  const deps: OauthLoginFlowDeps = {
    coordinator,
    fetchStatus: async () => overrides.status,
    gatewayAuthProviders: async () => [],
    hasSessionCookie: async () => true,
    log: () => undefined,
    openLoginWindow: async () => {
      state.windowsOpened += 1
    },
    releaseReauthLatch: () => {
      state.latchReleases += 1
    },
    runNativeLogin: async () => tokens,
    ...overrides
  }

  return { coordinator, deps, state, store }
}

describe('oauth-login flow releases the reauth latch only on a confirmed sign-in', () => {
  it('native: stored tokens release the latch', async () => {
    const { deps, state, store } = harness({ status: NATIVE_STATUS })

    await expect(runOauthLoginFlow(`${GATEWAY}/`, deps)).resolves.toEqual({
      ok: true,
      baseUrl: GATEWAY,
      connected: true
    })
    expect(store.get(GATEWAY)?.accessToken).toBe('at-new')
    expect(state).toEqual({ latchReleases: 1, windowsOpened: 0 })
  })

  it('native: a failed login keeps the latch', async () => {
    const { deps, state } = harness({
      status: NATIVE_STATUS,
      runNativeLogin: async () => {
        throw new Error('loopback timed out')
      }
    })

    await expect(runOauthLoginFlow(GATEWAY, deps)).resolves.toEqual({
      ok: false,
      error: 'loopback timed out',
      connected: false
    })
    expect(state.latchReleases).toBe(0)
  })

  it('native: a login superseded mid-flight keeps the latch and the newer identity', async () => {
    const { coordinator, deps, state, store } = harness({ status: NATIVE_STATUS })

    deps.runNativeLogin = async () => {
      coordinator.beginLogin(GATEWAY)

      return tokens
    }

    await expect(runOauthLoginFlow(GATEWAY, deps)).resolves.toMatchObject({ ok: false, connected: false })
    expect(store.get(GATEWAY)?.accessToken).toBe('at-old')
    expect(state.latchReleases).toBe(0)
  })

  it('cookie: a confirmed session releases the latch and supersedes the native identity', async () => {
    const { deps, state, store } = harness({ status: EMBEDDED_STATUS })

    await expect(runOauthLoginFlow(GATEWAY, deps)).resolves.toEqual({ ok: true, baseUrl: GATEWAY, connected: true })
    expect(store.has(GATEWAY)).toBe(false)
    expect(state).toEqual({ latchReleases: 1, windowsOpened: 1 })
  })

  it('cookie: an unreadable status still takes the embedded flow and releases on success', async () => {
    const { deps, state } = harness({
      status: null,
      fetchStatus: async () => {
        throw new Error('ECONNRESET')
      }
    })

    await expect(runOauthLoginFlow(GATEWAY, deps)).resolves.toMatchObject({ ok: true, connected: true })
    expect(state).toEqual({ latchReleases: 1, windowsOpened: 1 })
  })

  it('cookie: a closed login window keeps the latch and the native tokens', async () => {
    const { deps, state, store } = harness({ status: EMBEDDED_STATUS, hasSessionCookie: async () => false })

    await expect(runOauthLoginFlow(GATEWAY, deps)).resolves.toEqual({ ok: true, baseUrl: GATEWAY, connected: false })
    expect(store.get(GATEWAY)?.accessToken).toBe('at-old')
    expect(state.latchReleases).toBe(0)
  })

  it('cookie: a login superseded while its window was open throws and keeps the latch', async () => {
    const { coordinator, deps, state, store } = harness({ status: EMBEDDED_STATUS })

    deps.openLoginWindow = async () => {
      coordinator.beginLogin(GATEWAY)
    }

    await expect(runOauthLoginFlow(GATEWAY, deps)).rejects.toBeInstanceOf(NativeAuthChangedError)
    expect(store.get(GATEWAY)?.accessToken).toBe('at-old')
    expect(state.latchReleases).toBe(0)
  })

  it('a login superseded during the probe never opens a window', async () => {
    const { coordinator, deps, state } = harness({ status: EMBEDDED_STATUS })

    deps.fetchStatus = async () => {
      coordinator.beginLogin(GATEWAY)

      return EMBEDDED_STATUS
    }

    await expect(runOauthLoginFlow(GATEWAY, deps)).rejects.toBeInstanceOf(NativeAuthChangedError)
    expect(state).toEqual({ latchReleases: 0, windowsOpened: 0 })
  })
})
