// hc-417 device-code binding state machine (pure, framework-agnostic).
//
// The 飞书 binding is a device-code flow against the cloud v2 provisioning
// endpoints (hermes-cloud app/routers/desktop.py): provision (get a scan link +
// a provision_id) → the user scans + confirms → poll GET .../provision/{id}
// until 'success' — at which point the MAIN process fetches the credential from
// GET .../feishu/credentials and stores it. The RENDERER owns the polling loop
// (per the spike/PM); this reducer is the loop's brain, kept pure so it is
// exhaustively unit-testable and the React hook only wires timers + IPC to it.
//
// Timing (interval / expiry deadlines) is data ON the state, computed from a
// `now` the caller passes in — no clock is read here, so tests are deterministic.

export type DeviceCodePhase =
  | 'awaiting_scan' // have a scan link; polling for confirmation
  | 'error' // a stop condition (see DeviceCodeErrorReason)
  | 'idle' // nothing started
  | 'issuing' // the provision request is in flight
  | 'success' // credential fetched + stored; backend restarting

// Stable reasons a flow stops, mapped to copy in the dialog.
export type DeviceCodeErrorReason =
  | 'denied' // the user rejected the authorization
  | 'expired' // the code lapsed before confirmation (or the flow was lost)
  | 'keychain' // secure storage off → credential NOT saved
  | 'rate_limited' // another provision flow is already in flight (cloud 429)
  | 'request_failed' // repeated transient failures gave up
  | 'service_unavailable' // provisioning endpoint not reachable/deployed
  | 'sign_in' // no / expired login → sign in first

export interface DeviceCodeState {
  phase: DeviceCodePhase
  // Present in awaiting_scan:
  provisionId: string // the poll handle (cloud provision_id)
  qrUrl: string // the scan LINK — rendered as a QR code locally
  intervalMs: number // poll cadence
  expiresAt: number // epoch ms deadline; 0 when not applicable
  consecutiveFailures: number // transient poll failures in a row (bounded)
  // Present in success when the automatic backend restart failed — the binding
  // IS saved, the user just has to restart the app for it to take effect.
  restartFailed: boolean
  // Present in error:
  errorReason: DeviceCodeErrorReason | null
}

// Give up after this many back-to-back transient poll failures (network blips)
// so a flapping network eventually surfaces an error instead of polling forever.
export const MAX_CONSECUTIVE_POLL_FAILURES = 5

export type DeviceCodeEvent =
  | { type: 'CANCEL' } // user closed the flow
  | { type: 'EXPIRE' } // deadline reached (timer)
  | { type: 'FAIL'; reason: DeviceCodeErrorReason } // hook-driven terminal error (e.g. keychain)
  | { type: 'ISSUED'; provisionId: string; qrUrl: string; intervalMs: number; expiresAt: number }
  | { type: 'ISSUE_FAILED'; reason: DeviceCodeErrorReason }
  | { type: 'POLL_FAILED'; reason: 'request_failed' | 'service_unavailable' | 'sign_in' }
  | { type: 'POLL_RESULT'; status: 'denied' | 'expired' | 'pending' | 'success'; restartFailed?: boolean }
  | { type: 'RESET' } // back to idle (reuse the machine)
  | { type: 'START' } // begin issuing

export function initialDeviceCodeState(): DeviceCodeState {
  return {
    phase: 'idle',
    provisionId: '',
    qrUrl: '',
    intervalMs: 3000,
    expiresAt: 0,
    consecutiveFailures: 0,
    restartFailed: false,
    errorReason: null
  }
}

function toError(reason: DeviceCodeErrorReason): DeviceCodeState {
  return { ...initialDeviceCodeState(), phase: 'error', errorReason: reason }
}

/** Pure transition. Unknown/ill-timed events are no-ops (return the same state). */
export function deviceCodeReduce(state: DeviceCodeState, event: DeviceCodeEvent): DeviceCodeState {
  switch (event.type) {
    case 'START':
      // Only start from a resting phase; ignore a double-start mid-flight.
      if (state.phase === 'idle' || state.phase === 'error') {
        return { ...initialDeviceCodeState(), phase: 'issuing' }
      }

      return state

    case 'ISSUED':
      if (state.phase !== 'issuing') {
        return state
      }

      return {
        ...initialDeviceCodeState(),
        phase: 'awaiting_scan',
        provisionId: event.provisionId,
        qrUrl: event.qrUrl,
        intervalMs: event.intervalMs > 0 ? event.intervalMs : 3000,
        expiresAt: event.expiresAt
      }

    case 'ISSUE_FAILED':
      if (state.phase !== 'issuing') {
        return state
      }

      return toError(event.reason)
    case 'POLL_RESULT': {
      if (state.phase !== 'awaiting_scan') {
        return state
      }

      switch (event.status) {
        case 'success':
          return {
            ...state,
            phase: 'success',
            consecutiveFailures: 0,
            restartFailed: event.restartFailed === true
          }

        case 'denied':
          return toError('denied')

        case 'expired':
          return toError('expired')

        case 'pending':

        default:
          return { ...state, consecutiveFailures: 0 }
      }
    }

    case 'POLL_FAILED':
      if (state.phase !== 'awaiting_scan') {
        return state
      }

      // A missing/expired login or a dead endpoint is terminal immediately;
      // plain transient failures are tolerated up to the cap.
      if (event.reason === 'sign_in') {
        return toError('sign_in')
      }

      if (event.reason === 'service_unavailable') {
        return toError('service_unavailable')
      }

      if (state.consecutiveFailures + 1 >= MAX_CONSECUTIVE_POLL_FAILURES) {
        return toError('request_failed')
      }

      return { ...state, consecutiveFailures: state.consecutiveFailures + 1 }

    case 'EXPIRE':
      if (state.phase !== 'awaiting_scan') {
        return state
      }

      return toError('expired')

    case 'FAIL':
      // A terminal error the hook raises (e.g. keychain off on the success
      // path). Ignored once already resting so a late failure can't clobber a
      // success/idle state.
      if (state.phase === 'idle' || state.phase === 'success' || state.phase === 'error') {
        return state
      }

      return toError(event.reason)

    case 'CANCEL':

    case 'RESET':
      return initialDeviceCodeState()

    default:
      return state
  }
}

/** True while the flow should keep polling (the hook schedules the next tick). */
export function isPolling(state: DeviceCodeState): boolean {
  return state.phase === 'awaiting_scan'
}

/** True once the flow reached a resting/terminal phase (stop timers). */
export function isTerminal(state: DeviceCodeState): boolean {
  return state.phase === 'success' || state.phase === 'error'
}
