import { authModeFromStatus, normalizeRemoteBaseUrl } from './connection-config'
import { NativeAuthChangedError } from './native-access-token'
import type { AdvertisedAuthProvider } from './native-auth-decisions'
import { type NativeTokenSet, resolveLoginStrategy } from './native-oauth'

export interface OauthLoginFlowDeps {
  coordinator: {
    beginLogin: (baseUrl: string) => () => boolean
    clearTokens: (baseUrl: string) => void
    storeTokens: (baseUrl: string, tokens: NativeTokenSet) => void
  }
  /** The gateway's public /api/status body; a failure falls through to the embedded flow. */
  fetchStatus: (baseUrl: string) => Promise<unknown>
  gatewayAuthProviders: (baseUrl: string) => Promise<AdvertisedAuthProvider[]>
  hasSessionCookie: (baseUrl: string) => Promise<boolean>
  log: (line: string) => void
  openLoginWindow: (baseUrl: string) => Promise<unknown>
  /**
   * A CONFIRMED sign-in releases the remote reauth latch (#95701) so the next
   * startHermes() re-dials instead of replaying the stale rejection, and its
   * boot-progress updates are no longer held behind the "session expired" error.
   */
  releaseReauthLatch: () => void
  runNativeLogin: (baseUrl: string) => Promise<NativeTokenSet>
}

export type OauthLoginResult =
  { baseUrl: string; connected: boolean; ok: true } | { connected: false; error: string; ok: false }

/**
 * hermes:connection-config:oauth-login, moved out of main.ts (hc-919) so both
 * sign-in shapes are tested on the code that ships.
 *
 * Capability-gated login (RFC 8252). Probe the gateway's public /api/status
 * for supported auth_flows and /api/auth/providers for provider capabilities:
 *   - all providers support password → always use the embedded login window
 *     (password providers require the dashboard login form; native PKCE
 *     can never complete for that provider shape)
 *   - advertises "native_pkce" AND at least one non-password provider →
 *     run the system-browser + loopback + PKCE flow
 *   - older gateway with no provider metadata → fall back to the auth_flows
 *     check (existing compatibility)
 *   - a failed native login reports the error rather than auto-falling back
 *     to the embedded flow — one sign-in action opens at most one window.
 */
export async function runOauthLoginFlow(rawUrl: unknown, deps: OauthLoginFlowDeps): Promise<OauthLoginResult> {
  const baseUrl = normalizeRemoteBaseUrl(rawUrl)
  // Order login attempts without interrupting rotation of the existing session.
  const authIsCurrent = deps.coordinator.beginLogin(baseUrl)

  let statusBody: any = null

  try {
    statusBody = await deps.fetchStatus(baseUrl)
  } catch {
    // Can't read status — fall through to the embedded flow, which has its
    // own error handling and works against any gated gateway.
  }

  const authRequired = statusBody && authModeFromStatus(statusBody) === 'oauth'
  const providers = authRequired ? await deps.gatewayAuthProviders(baseUrl) : []

  const strategy = resolveLoginStrategy(statusBody, { providers })

  if (!authIsCurrent()) {
    throw new NativeAuthChangedError()
  }

  if (strategy === 'native') {
    try {
      const tokens = await deps.runNativeLogin(baseUrl)

      if (!authIsCurrent()) {
        throw new NativeAuthChangedError()
      }

      deps.coordinator.storeTokens(baseUrl, tokens)
      deps.releaseReauthLatch()

      return { ok: true, baseUrl, connected: true }
    } catch (error) {
      deps.log(`[native-oauth] native login failed (${error instanceof Error ? error.message : String(error)})`)

      return { ok: false, error: error instanceof Error ? error.message : String(error), connected: false }
    }
  }

  // Legacy embedded-webview cookie flow.
  await deps.openLoginWindow(baseUrl)
  const connected = await deps.hasSessionCookie(baseUrl)

  // Only a CONFIRMED sign-in releases the latch (upstream 22751c8fd9, dropped
  // by the hc-844 merge). A cancelled/closed login window must leave it set, or
  // the overlay's "Sign in" button starts flickering again on the next retry.
  if (!authIsCurrent()) {
    throw new NativeAuthChangedError()
  }

  if (connected) {
    // A confirmed cookie login supersedes any older native identity.
    deps.coordinator.clearTokens(baseUrl)
    deps.releaseReauthLatch()
  }

  return { ok: true, baseUrl, connected }
}
