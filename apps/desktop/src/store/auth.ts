import { atom } from 'nanostores'

import type { DesktopAuthGateEvent, DesktopManagedStatus } from '@/global'

// The desktop's login gate is the ApexNodes managed-LLM account (Desktop V0.2,
// China-first): a signed-in user gets zero-key chat via the relay. This store is
// the single source of truth for "is the user logged in?" — the boot gate blocks
// the chat UI until `status === 'signed-in'`, and the continuous auth gate flips
// it back to 'signed-out' / 'disabled' when a backend call reports 401 / 403
// account_disabled. It REUSES the existing managed bridge
// (window.hermesDesktop.managed) — it does not add a second auth system.

export interface AuthAccount {
  email: string
  name: string
  plan: string
}

export type AuthStatus =
  // First status() call hasn't resolved yet — hold the gate (show nothing /
  // the boot overlay), never flash the login screen at a returning user.
  | 'checking'
  // Signed in (relay key on disk) — chat is unblocked.
  | 'signed-in'
  // Not signed in — show the login screen and block chat.
  | 'signed-out'
  // Account abnormal (403 account_disabled) — show the login screen with the
  // account-disabled message; the user must re-authenticate.
  | 'disabled'
  // hc-519: a relay key IS on disk but the relay rejected it (401) and self-heal
  // couldn't mint a fresh one (no reusable login token, or an expired JWT). The
  // managed session is dead even though the key file exists — the OLD split-brain
  // was: account card kept showing "已登录" (key present) while the model catalog
  // said "登录已失效" (key rejected). This is the reconciled truth: identity is
  // retained for display, the account card renders a "登录已失效" degrade, and the
  // send path routes to re-sign-in. A softer degrade than 'signed-out': it keeps
  // the local workspace usable and lets the sidebar card be the honest, clickable
  // signal, rather than nuking the window to a full login screen for a
  // managed-only failure. Escalates to 'signed-out' if the key is later cleared.
  | 'expired'

export interface DesktopAuthState {
  account: AuthAccount
  /** True on builds where the managed-LLM default path is enabled. On a
   *  managed-disabled build (APEXNODES_MANAGED=0) the account gate is a no-op and
   *  the app relies on the BYOK onboarding instead. null until the first check. */
  enabled: boolean | null
  /** Why the gate last tripped mid-session, so the login screen can show the
   *  right message. null on a clean first run (never signed in) — then the login
   *  screen shows just the buttons, no notice. Cleared on successful sign-in. */
  gateReason: 'account_disabled' | 'unauthorized' | null
  /** hc-519 rollback switch (default true), mirrored from managed status. When
   *  false, relay-auth loss does NOT drive the global state to 'expired' — the
   *  app falls back to the hc-511 behavior (a relay 401 is only surfaced on a
   *  chat send). Read by the recovery + startup/catalog reconcile paths. */
  loginTruth: boolean
  status: AuthStatus
}

const EMPTY_ACCOUNT: AuthAccount = { email: '', name: '', plan: '' }

// Seed "signed-in" from localStorage so a returning user goes straight to chat
// without the login screen flashing while the first status() call resolves. The
// real check reconciles it a beat later (and signs them out if the key is gone).
const SIGNED_IN_CACHE_KEY = 'apexnodes-desktop-signed-in-v1'

function readCachedSignedIn(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(SIGNED_IN_CACHE_KEY) === '1'
  } catch {
    return false
  }
}

function writeCachedSignedIn(value: boolean) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (value) {
      window.localStorage.setItem(SIGNED_IN_CACHE_KEY, '1')
    } else {
      window.localStorage.removeItem(SIGNED_IN_CACHE_KEY)
    }
  } catch {
    // localStorage unavailable — degrade silently.
  }
}

export const $authState = atom<DesktopAuthState>({
  account: EMPTY_ACCOUNT,
  enabled: null,
  gateReason: null,
  // Default on until the first status() reports the real switch value — a race
  // before that resolves fails safe to the new single-source-of-truth behavior.
  loginTruth: true,
  // A cached signed-in user starts unblocked; everyone else waits for the check.
  status: readCachedSignedIn() ? 'signed-in' : 'checking'
})

const patch = (update: Partial<DesktopAuthState>) => $authState.set({ ...$authState.get(), ...update })

function accountFromStatus(status: DesktopManagedStatus): AuthAccount {
  return {
    email: status.email || '',
    name: status.name || '',
    plan: status.plan || ''
  }
}

let refreshPromise: null | Promise<void> = null

// Read the managed status via the desktop bridge and reconcile the gate.
//   - bridge absent (web dashboard / dev preview) → managed disabled, don't gate.
//   - enabled && signedIn → signed-in (unblock chat).
//   - enabled && !signedIn → signed-out (show login) UNLESS the gate was already
//     flipped to 'disabled' this session (a re-check must not downgrade the
//     account-abnormal message to a generic logged-out one).
//   - !enabled → managed off for this build; don't block on the account gate.
// Deduped so concurrent callers share one in-flight request.
export async function refreshAuthStatus(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise
  }

  const run = (async () => {
    const bridge = typeof window !== 'undefined' ? window.hermesDesktop?.managed : undefined

    if (!bridge) {
      patch({ enabled: false })

      return
    }

    try {
      const status = await bridge.status()

      // hc-519: mirror the rollback switch (default on) so the recovery + reconcile
      // paths read one value. undefined (older main process) → on (fail-safe).
      const loginTruth = status.loginStateTruth !== false

      if (!status.enabled) {
        // Managed off — the account gate doesn't apply; leave chat unblocked.
        patch({ enabled: false, loginTruth, status: 'signed-in', account: EMPTY_ACCOUNT, gateReason: null })
        writeCachedSignedIn(false)

        return
      }

      if (status.signedIn) {
        // hc-519: a status() that reports signedIn=true means only that a relay
        // KEY is on disk — not that it is valid. If relay-auth loss already flipped
        // us to 'expired' this session, a re-check must NOT launder that stale key
        // back into 'signed-in' (that laundering was the A-9 split-brain). Only a
        // real recovery (clearRelayAuthExpiry, after a heal / re-sign-in) leaves
        // 'expired'. Account/loginTruth still refresh so the degraded card shows
        // who was signed in.
        const stillExpired = $authState.get().status === 'expired'
        patch({
          enabled: true,
          loginTruth,
          status: stillExpired ? 'expired' : 'signed-in',
          account: accountFromStatus(status),
          gateReason: stillExpired ? 'unauthorized' : null
        })
        writeCachedSignedIn(!stillExpired)

        return
      }

      // Not signed in (no key at all). Preserve an already-shown 'disabled'
      // message this session; an 'expired' relay session with the key now gone
      // escalates to a full 'signed-out' gate (identity-level failure).
      writeCachedSignedIn(false)
      patch({
        enabled: true,
        loginTruth,
        account: EMPTY_ACCOUNT,
        status: $authState.get().status === 'disabled' ? 'disabled' : 'signed-out'
      })
    } catch {
      // status() threw (bridge error). Don't hard-block a returning user on a
      // transient IPC failure: keep a cached signed-in state, otherwise treat as
      // signed-out so the login screen can offer a retry.
      patch({ enabled: true, status: readCachedSignedIn() ? 'signed-in' : 'signed-out' })
    }
  })()

  refreshPromise = run
  // Clear the dedup slot once settled — via `.finally` on the ALREADY-ASSIGNED
  // promise, never an inner `finally`. The bridge-absent path completes
  // synchronously (no await), so an inner finally would run BEFORE the outer
  // `refreshPromise = run` assignment and leave the resolved promise wedged in
  // the slot — every later refresh would then dedup to it and no-op. (Benign in
  // production where the Electron bridge is always present; it wedged web/dev
  // preview and the test harness where the bridge toggles.) Scheduling here runs
  // the clear as a microtask after the assignment, on every path.
  void run.finally(() => {
    refreshPromise = null
  })

  return run
}

// Called after a successful sign-in (the onboarding managed flow completes, or
// the login screen's browser flow resolves). Optimistically unblocks chat, then
// re-reads status so the account panel gets the real email/plan.
export function markSignedIn(account?: Partial<AuthAccount>) {
  writeCachedSignedIn(true)
  patch({
    status: 'signed-in',
    gateReason: null,
    account: { ...EMPTY_ACCOUNT, ...(account ?? {}) }
  })
  void refreshAuthStatus()
}

// Continuous auth gate: a backend call reported 401 (login lost) or 403
// account_disabled (account abnormal). Clear the cached signed-in state and flip
// the gate so the login screen takes over — the app cannot keep being used.
export function handleAuthGate(payload: DesktopAuthGateEvent) {
  // Ignore on managed-disabled builds — there's no account gate to trip, and a
  // stray 401/403 from a BYOK backend shouldn't force a login screen that build
  // doesn't have.
  if ($authState.get().enabled === false) {
    return
  }

  writeCachedSignedIn(false)
  patch({
    account: EMPTY_ACCOUNT,
    gateReason: payload.reason,
    status: payload.reason === 'account_disabled' ? 'disabled' : 'signed-out'
  })
}

// hc-519 — single source of truth for relay-key validity. The relay rejected the
// stored key with a 401 (from the model catalog probe, a chat send, or the
// startup probe) AND self-heal couldn't mint a fresh one. Reconcile the global
// login state to 'expired' so the account card stops lying ("已登录") and shows
// the "登录已失效" degrade. Unlike handleAuthGate, this KEEPS the account identity
// so the degraded card can show who was signed in. No-op on a managed-disabled
// build, or when the rollback switch is off (then relay 401 stays a chat-send-
// only signal, per hc-511). Idempotent.
export function handleRelayAuthExpired() {
  const state = $authState.get()

  if (state.enabled === false || state.loginTruth === false) {
    return
  }

  writeCachedSignedIn(false)
  patch({ gateReason: 'unauthorized', status: 'expired' })
}

// hc-519 — the inverse of handleRelayAuthExpired: a relay-key recovery landed (a
// successful self-heal minted a fresh key, or the user re-signed-in), so lift the
// 'expired' degrade back to 'signed-in'. Only acts when currently 'expired' — it
// never manufactures a signed-in state out of thin air (a real sign-in goes
// through markSignedIn / refreshAuthStatus), it just clears the degrade the relay
// tripped. The account identity is retained across the round-trip.
export function clearRelayAuthExpiry() {
  if ($authState.get().status !== 'expired') {
    return
  }

  writeCachedSignedIn(true)
  patch({ gateReason: null, status: 'signed-in' })
}

// Escape hatch for the "logged in but the relay-key endpoint isn't deployed"
// case: the managed browser sign-in succeeded (valid account) but couldn't
// provision a relay key, so the onboarding store degrades to BYOK. Managed is
// effectively unavailable this run — drop the account gate so the BYOK onboarding
// picker (which mounts once the gate is satisfied) can take over instead of
// trapping the user on a login screen that can never succeed. On prod
// provision-key is deployed, so this is a rare fallback, not the normal path.
export function markManagedUnavailable() {
  patch({ enabled: false, status: 'signed-in', account: EMPTY_ACCOUNT, gateReason: null })
}

// User chose "退出登录" (logout) in the account panel. Clears the relay key on
// disk via the managed bridge, then flips the gate to signed-out so the login
// screen takes over.
export async function signOutAccount(): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.hermesDesktop?.managed : undefined

  try {
    await bridge?.signOut()
  } catch {
    // Best-effort: even if the IPC clear fails, drop the local session so the
    // user isn't stranded in a half-signed-out state.
  }

  writeCachedSignedIn(false)
  patch({ account: EMPTY_ACCOUNT, gateReason: null, status: 'signed-out' })
}
