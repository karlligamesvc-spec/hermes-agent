import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { DesktopLoginScreen } from '@/components/desktop-login-screen'
import { useI18n } from '@/i18n'
import { $authState, handleAuthGate, refreshAuthStatus } from '@/store/auth'
import { reconcileRelayAuthState } from '@/store/managed-recovery'
import type { OnboardingContext } from '@/store/onboarding'

interface DesktopAuthGateProps {
  /** True once the local backend/env is ready (gatewayState === 'open'), mirroring
   *  the onboarding overlay's gate. The login-state check only runs after env is
   *  ready, so on a first launch the env/install overlay shows first, THEN the
   *  login screen — never both at once, never the login screen before env is up. */
  enabled: boolean
  onSignedIn?: () => void
  requestGateway: OnboardingContext['requestGateway']
}

// The hard auth gate. Boot order: (a) env-ready gate = the existing bootstrap /
// gateway overlays (unchanged), then (b) THIS login-state check. When the user
// isn't signed in (or the account is abnormal), it renders a full-window login
// screen that BLOCKS the chat UI; only a successful sign-in lets the app through.
// It also wires the continuous auth gate: a 401 / 403 account_disabled from any
// backend call flips the state back to signed-out and the login screen retakes
// the window.
export function DesktopAuthGate({ enabled, onSignedIn, requestGateway }: DesktopAuthGateProps) {
  const { t } = useI18n()
  const { enabled: managedEnabled, gateReason, loginTruth, status } = useStore($authState)
  const startupReconcileDone = useRef(false)

  // Continuous auth gate: subscribe once to the main-process broadcast so a lost
  // login / disabled account anywhere in the app returns the user here. Mounted
  // unconditionally (independent of `enabled`) so a mid-session 401 is caught
  // even while an overlay is up.
  useEffect(() => {
    const unsubscribe = window.hermesDesktop?.onAuthGate?.(handleAuthGate)

    return () => unsubscribe?.()
  }, [])

  // Run the login-state check once env is ready. Re-run when env flips to ready
  // so a fresh install lands on the login screen right after bootstrap finishes.
  useEffect(() => {
    if (enabled) {
      void refreshAuthStatus()
    }
  }, [enabled])

  // hc-519 startup validity probe. A cached/on-disk relay key makes status()
  // report signedIn=true regardless of whether the relay still ACCEPTS it — the
  // "replace-install kept a stale ~/.apexnodes key" case (A-9). Once env is ready
  // and a managed install is signed in, probe the relay key via the self-heal
  // bridge exactly once: a valid key is a no-op, a rotated key self-heals
  // silently, a dead key with no reusable token degrades the account card to
  // "登录已失效". Gated on managedEnabled===true (status() resolved + managed on)
  // and the rollback switch; off → hc-511 (no startup probe).
  useEffect(() => {
    if (!enabled || managedEnabled !== true || status !== 'signed-in' || !loginTruth) {
      return
    }

    if (startupReconcileDone.current) {
      return
    }

    startupReconcileDone.current = true
    void reconcileRelayAuthState()
  }, [enabled, managedEnabled, status, loginTruth])

  // Env not ready yet, already signed in, or in the hc-519 'expired' soft-degrade
  // (the sidebar account card + model menu carry that state; a managed-only relay
  // expiry must not nuke the whole window to a full login screen) → don't gate:
  // the boot/env overlays cover the pre-ready phase, and a signed-in user goes
  // straight to chat.
  if (!enabled || status === 'signed-in' || status === 'expired') {
    return null
  }

  // Env is ready but the first login-state check hasn't resolved yet. Cover the
  // window with the login surface (no buttons) so the chat never flashes before
  // we know whether to gate — resolves within one status() round-trip, then this
  // swaps to the real login screen or unmounts. A returning user is seeded
  // 'signed-in' from cache and never reaches here.
  if (status === 'checking') {
    return <div className="fixed inset-0 z-1400 bg-(--ui-chat-surface-background) [-webkit-app-region:drag]" />
  }

  // 'disabled' → account abnormal; a 'signed-out' that followed a 401 gate →
  // session-expired copy; a clean first-run 'signed-out' shows just the buttons.
  const notice =
    status === 'disabled'
      ? t.auth.login.accountDisabled
      : gateReason === 'unauthorized'
        ? t.auth.login.sessionExpired
        : null

  return <DesktopLoginScreen gateNotice={notice} onSignedIn={onSignedIn} requestGateway={requestGateway} />
}
