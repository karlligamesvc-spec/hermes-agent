/**
 * hc-602 — the model catalog's 401 must reach the SAME managed self-heal the
 * chat send uses.
 *
 * hc-592 looked at this exact path ("entry C: the key ages out and the live
 * catalog probe 401s") and filed it as a different mechanism, out of scope. It
 * is not a different mechanism: the runtime probes the relay's live
 * `GET /v1/models` with `custom_providers[].api_key`, that is the same rotated
 * credential the chat path 401s on, and it is the exit that was still open after
 * hc-595 healed the other one. On Kael's install the result was a model menu
 * showing one model, a refresh button that changed nothing, and no error
 * anywhere — the runtime's probe failure is silent by design.
 *
 * These tests pin the wiring and its guards. They do NOT assert "the store
 * function was called with the right arguments" — they assert the behaviour that
 * matters: a collapsed catalog probes, a healthy one does not, a heal is the
 * signal to re-query, and a repeat call inside the shared dedupe cannot storm
 * the relay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managedCatalogCollapsed } from '@/lib/managed-catalog'
import { recoverManagedCatalogAuth } from '@/store/managed-recovery'
import type { ModelOptionProvider } from '@/types/hermes'

// The self-heal bridge the electron main process exposes to the renderer.
type SelfHeal = () => Promise<{
  ok: boolean
  relayUnauthorized: boolean
  healed: boolean
  hasToken: boolean
  assignment?: unknown
}>

const setModelAssignment = vi.hoisted(() => vi.fn(async () => undefined))
const gatewayRequest = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/hermes', () => ({ setModelAssignment }))
vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => ({ request: gatewayRequest }) }
}))

function installBridge(selfHeal: SelfHeal | null) {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(window as any).hermesDesktop = selfHeal ? { managed: { selfHeal } } : {}
}

const ASSIGNMENT = {
  scope: 'main',
  provider: 'custom',
  model: 'deepseek-v4-pro-APEX',
  base_url: 'https://apex-nodes.com/relay/v1',
  api_key: 'sk-fresh-not-a-real-key'
}

/** A relay directory as the picker receives it. */
function managedRow(models: string[]): ModelOptionProvider {
  return { slug: 'apex-nodes.com', name: 'APEX-NODES.COM', models } as ModelOptionProvider
}

beforeEach(() => {
  setModelAssignment.mockClear()
  gatewayRequest.mockClear()
})

afterEach(() => {
  delete (window as any).hermesDesktop
  vi.restoreAllMocks()
})

describe('managedCatalogCollapsed — the silent 401, made visible', () => {
  it('a one-model managed row is the fallback the runtime writes on a probe failure', () => {
    // The single id is the one config.yaml names; the live directory has four.
    expect(managedCatalogCollapsed(managedRow(['deepseek-v4-pro-APEX']))).toBe(true)
    expect(managedCatalogCollapsed(managedRow([]))).toBe(true)
  })

  it('a live directory is never mistaken for a collapse', () => {
    expect(managedCatalogCollapsed(managedRow(['deepseek-v4-pro', 'qwen3.7-max', 'glm-5.2']))).toBe(false)
  })

  it('no managed row at all (BYOK / signed out) never triggers a probe', () => {
    expect(managedCatalogCollapsed(null)).toBe(false)
    expect(managedCatalogCollapsed(undefined)).toBe(false)
  })
})

describe('recoverManagedCatalogAuth', () => {
  it('a rotated key heals and reports it, so the caller re-queries the catalog', async () => {
    installBridge(async () => ({
      ok: true,
      relayUnauthorized: true,
      healed: true,
      hasToken: true,
      assignment: ASSIGNMENT
    }))

    await expect(recoverManagedCatalogAuth()).resolves.toBe(true)
    // The freshly minted key is applied the same way sign-in applies it, and the
    // running backend is told to re-read its env — otherwise the re-query would
    // hit the same live process still holding the dead credential.
    expect(setModelAssignment).toHaveBeenCalledWith(ASSIGNMENT)
    expect(gatewayRequest).toHaveBeenCalledWith('reload.env')
  })

  it('a relay that accepts the key is a no-op — a short list is not always a 401', async () => {
    installBridge(async () => ({ ok: true, relayUnauthorized: false, healed: false, hasToken: true }))

    await expect(recoverManagedCatalogAuth()).resolves.toBe(false)
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('a dead key with no reusable token reports "not healed" instead of re-querying forever', async () => {
    installBridge(async () => ({ ok: true, relayUnauthorized: true, healed: false, hasToken: false }))

    // Owned (the account card degrades to 登录已失效 via handleRelayAuthExpired)
    // but NOT healed — so the catalog is not re-queried into the same 401.
    await expect(recoverManagedCatalogAuth()).resolves.toBe(false)
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('concurrent probes collapse to one — a reopened menu cannot storm the relay', async () => {
    let inFlight = 0
    let peak = 0
    let calls = 0

    installBridge(async () => {
      calls += 1
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1

      return { ok: true, relayUnauthorized: true, healed: true, hasToken: true, assignment: ASSIGNMENT }
    })

    const [first, second] = await Promise.all([recoverManagedCatalogAuth(), recoverManagedCatalogAuth()])

    expect(calls).toBe(1)
    expect(peak).toBe(1)
    // The winner heals; the deduped caller is told nothing changed for IT, which
    // is what keeps a second invalidate from racing the first.
    expect(first !== second).toBe(true)
  })

  it('no desktop bridge (web dashboard / dev preview) is a silent no-op', async () => {
    installBridge(null)

    await expect(recoverManagedCatalogAuth()).resolves.toBe(false)
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('a bridge that throws never leaves the menu wedged', async () => {
    installBridge(async () => {
      throw new Error('IPC channel closed')
    })

    await expect(recoverManagedCatalogAuth()).resolves.toBe(false)
  })
})
