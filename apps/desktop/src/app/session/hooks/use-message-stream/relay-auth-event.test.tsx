/**
 * hc-595 — a chat turn's relay 401 must reach the managed self-heal.
 *
 * The relay auth failure happens INSIDE the local backend process (the runtime
 * logs `AuthenticationError [HTTP 401] {"detail":"Invalid Agent API key"}` and
 * aborts the turn), so the terminal `error` event this handler receives is the
 * shell's ONLY signal that the managed key was rotated out. Before hc-595 the
 * recovery was exported but wired to nothing on this path: the shell showed a
 * generic "Hermes error" toast and the self-heal only ever ran at boot / from
 * the model catalog — so a running app 401ed on every send until the user quit
 * and signed in again.
 */
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import type * as ManagedRecovery from '@/store/managed-recovery'
import { $notifications, clearNotifications } from '@/store/notifications'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

const recover = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/store/managed-recovery', async importOriginal => ({
  ...(await importOriginal<typeof ManagedRecovery>()),
  recoverFromManagedRelayAuthError: recover
}))

const SID = 'session-1'
let handleEvent: ((event: RpcEvent) => void) | null = null

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      sessionStateByRuntimeIdRef.current.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

async function mountStream() {
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

function emitError(payload: RpcEvent['payload']) {
  act(() => handleEvent!({ payload, session_id: SID, type: 'error' }))
}

const AUTH_ERROR = {
  code: 'auth',
  message: 'AuthenticationError [HTTP 401] {"detail":"Invalid Agent API key"}',
  retryable: false,
  status_code: 401
}

describe('useMessageStream relay-auth recovery', () => {
  beforeEach(() => {
    handleEvent = null
    recover.mockReset()
    recover.mockResolvedValue(true)
    clearNotifications()
  })

  afterEach(() => {
    cleanup()
  })

  it('routes a relay 401 turn error into the managed self-heal', async () => {
    await mountStream()
    emitError(AUTH_ERROR)

    await waitFor(() => expect(recover).toHaveBeenCalledTimes(1))
    expect(recover).toHaveBeenCalledWith({ sessionId: SID, isActive: true })
    // Recovery owns the outcome (its own healed / re-sign-in notice), so the
    // generic turn-error toast stays out of the way.
    await waitFor(() => expect($notifications.get().some(n => n.id.startsWith('gateway-error:'))).toBe(false))
  })

  it('falls back to the generic error toast when it was not a managed-relay failure', async () => {
    // A BYOK provider's own 401: the shell must not swallow it.
    recover.mockResolvedValue(false)
    await mountStream()
    emitError(AUTH_ERROR)

    await waitFor(() => expect($notifications.get().some(n => n.id.startsWith('gateway-error:'))).toBe(true))
  })

  it('leaves ordinary turn errors on the generic path', async () => {
    await mountStream()
    emitError({ message: 'Insufficient balance' })

    await waitFor(() =>
      expect($notifications.get().some(n => n.id === 'gateway-error:Insufficient balance')).toBe(true)
    )
    expect(recover).not.toHaveBeenCalled()
  })
})
