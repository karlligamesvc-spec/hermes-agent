import { describe, expect, it } from 'vitest'

import {
  evaluateRuntimeReadiness,
  fetchRuntimeReadinessSignals,
  interpretRuntimeReadiness,
  runtimeReadinessDisplay,
  waitForRuntimeReadiness
} from './runtime-readiness'

describe('interpretRuntimeReadiness', () => {
  it('prefers runtime_check when both signals exist', () => {
    const result = interpretRuntimeReadiness({
      setup: { provider_configured: false },
      setupError: null,
      runtime: { ok: true },
      runtimeError: null
    })

    expect(result).toEqual({
      checksDisagree: true,
      ready: true,
      reason: null,
      source: 'runtime_check'
    })
  })

  it('surfaces runtime mismatch details when runtime_check fails', () => {
    const result = interpretRuntimeReadiness({
      setup: { provider_configured: true },
      setupError: null,
      runtime: { error: 'No provider can serve the selected model.', ok: false },
      runtimeError: null
    })

    expect(result.ready).toBe(false)
    expect(result.source).toBe('runtime_check')
    expect(result.checksDisagree).toBe(true)
    expect(result.reason).toContain('No provider can serve the selected model.')
    expect(result.reason).toContain('setup.status reports configured credentials')
  })

  it('falls back to setup.status when runtime_check has no boolean result', () => {
    const result = interpretRuntimeReadiness({
      setup: { provider_configured: true },
      setupError: null,
      runtime: null,
      runtimeError: 'runtime check RPC unavailable'
    })

    expect(result).toEqual({
      checksDisagree: false,
      ready: true,
      reason: null,
      source: 'setup_status'
    })
  })

  it('uses explicit fallback when both checks are missing', () => {
    const result = interpretRuntimeReadiness({
      setup: null,
      setupError: 'setup.status timeout',
      runtime: null,
      runtimeError: 'setup.runtime_check timeout'
    })

    expect(result.ready).toBe(false)
    expect(result.source).toBe('fallback')
    expect(result.reason).toBe('setup.runtime_check timeout')
  })
})

describe('fetchRuntimeReadinessSignals', () => {
  it('scopes setup.runtime_check to the requested provider', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []

    const requestGateway = async <T = unknown>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })

      if (method === 'setup.status') {
        return { provider_configured: true } as T
      }

      if (method === 'setup.runtime_check') {
        return { ok: true } as T
      }

      throw new Error(`unexpected method: ${method}`)
    }

    await fetchRuntimeReadinessSignals(requestGateway, 'nous')

    expect(calls).toEqual([{ method: 'setup.status' }, { method: 'setup.runtime_check', params: { provider: 'nous' } }])
  })
})

describe('evaluateRuntimeReadiness', () => {
  it('forwards requestedProvider to setup.runtime_check', async () => {
    const requestGateway = async <T = unknown>(method: string, params?: Record<string, unknown>) => {
      if (method === 'setup.status') {
        return { provider_configured: true } as T
      }

      if (method === 'setup.runtime_check') {
        expect(params).toEqual({ provider: 'nous' })

        return { ok: true } as T
      }

      throw new Error(`unexpected method: ${method}`)
    }

    const result = await evaluateRuntimeReadiness(requestGateway, { requestedProvider: 'nous' })

    expect(result.ready).toBe(true)
  })
})

describe('runtimeReadinessDisplay', () => {
  it('does not call configured credentials setup when runtime resolution fails', () => {
    expect(
      runtimeReadinessDisplay({
        checksDisagree: true,
        ready: false,
        reason: 'Anthropic cannot serve the selected model.',
        source: 'runtime_check'
      })
    ).toBe('unavailable')
  })

  it('keeps needs-setup for an authoritative unconfigured result', () => {
    expect(
      runtimeReadinessDisplay({
        checksDisagree: false,
        ready: false,
        reason: 'No provider configured.',
        source: 'setup_status'
      })
    ).toBe('needs_setup')
  })
})

// hc-1121: the primary restarts for a new relay key, and the socket is down for a moment.
describe('waitForRuntimeReadiness', () => {
  const answers = (ok: boolean, downFor: number) => {
    let calls = 0

    const request = (async (method: string) => {
      if (method === 'setup.runtime_check') {
        calls += 1
      }

      if (calls <= downFor) {
        throw new Error('Hermes gateway is not connected')
      }

      return method === 'setup.status' ? { provider_configured: true } : { ok }
    }) as never

    return { calls: () => calls, request }
  }

  it('waits out a gateway that is not there yet', async () => {
    const engine = answers(true, 3)

    const result = await waitForRuntimeReadiness(engine.request, { unknownReady: false }, { retryMs: 1, timeoutMs: 5_000 })

    expect(result).toMatchObject({ ready: true, source: 'runtime_check' })
    expect(engine.calls()).toBe(4)
  })

  it('takes the engine at its word: an answer that says not ready is not asked again', async () => {
    const engine = answers(false, 0)

    const result = await waitForRuntimeReadiness(engine.request, { unknownReady: false }, { retryMs: 1, timeoutMs: 5_000 })

    expect(result).toMatchObject({ ready: false, source: 'runtime_check' })
    expect(engine.calls()).toBe(1)
  })

  it('gives up when the time runs out, still reporting that nothing answered', async () => {
    const engine = answers(true, Number.POSITIVE_INFINITY)

    const result = await waitForRuntimeReadiness(engine.request, { unknownReady: false }, { retryMs: 1, timeoutMs: 20 })

    expect(result).toMatchObject({ ready: false, source: 'fallback' })
    expect(engine.calls()).toBeGreaterThan(1)
  })

  it('stops asking once nobody wants the answer', async () => {
    const engine = answers(true, Number.POSITIVE_INFINITY)

    await waitForRuntimeReadiness(engine.request, { unknownReady: false }, { isCurrent: () => false, retryMs: 1, timeoutMs: 5_000 })

    expect(engine.calls()).toBe(1)
  })
})
