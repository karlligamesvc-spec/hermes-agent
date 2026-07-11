import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getGlobalModelInfo } from '@/hermes'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  setCurrentModel,
  setCurrentProvider
} from '@/store/session'

import { useModelControls } from './use-model-controls'

const setGlobalModel = vi.fn()
const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: vi.fn(),
  setGlobalModel: (...args: Parameters<typeof setGlobalModel>) => setGlobalModel(...args)
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      desktop: {
        modelSwitchFailed: 'Model switch failed',
        modelNotInCatalogTitle: 'Selected model unavailable',
        modelNotInCatalog: 'Switched back to the default model.'
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notify: (...args: Parameters<typeof notify>) => notify(...args),
  notifyError: (...args: Parameters<typeof notifyError>) => notifyError(...args)
}))

type Controls = ReturnType<typeof useModelControls>

function Harness({
  activeSessionId,
  onReady,
  requestGateway
}: {
  activeSessionId: string | null
  onReady: (controls: Controls) => void
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const controls = useModelControls({
    activeSessionId,
    queryClient: new QueryClient(),
    requestGateway
  })

  onReady(controls)

  return null
}

describe('useModelControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $activeSessionId.set(null)
    setCurrentModel('')
    setCurrentProvider('')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    $activeSessionId.set(null)
    setCurrentModel('')
    setCurrentProvider('')
  })

  it('applies the global model when there is no active runtime session', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({
      model: 'openai/gpt-5.5',
      provider: 'openai-codex'
    })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: null,
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('openai/gpt-5.5')
    expect($currentProvider.get()).toBe('openai-codex')
  })

  it('does not clobber the active session footer state with global model info', async () => {
    setCurrentModel('deepseek/deepseek-v4-pro')
    setCurrentProvider('deepseek')
    $activeSessionId.set('runtime-1')
    vi.mocked(getGlobalModelInfo).mockResolvedValue({
      model: 'openai/gpt-5.5',
      provider: 'openai-codex'
    })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: 'runtime-1',
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('deepseek/deepseek-v4-pro')
    expect($currentProvider.get()).toBe('deepseek')
  })

  it('routes active-session picker changes through config.set with an explicit provider', async () => {
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'claude-sonnet-4.6' }) as never)
    let controls!: Controls

    render(
      <Harness
        activeSessionId="session-1"
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'session-1',
      key: 'model',
      value: 'claude-sonnet-4.6 --provider anthropic'
    })
    expect(requestGateway).not.toHaveBeenCalledWith('slash.exec', expect.anything())
  })

  it('stores a no-session pick as UI state with no gateway or global write', async () => {
    const requestGateway = vi.fn()
    let controls!: Controls

    render(
      <Harness
        activeSessionId={null}
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    // The pick is plain UI state; session.create ships it later. Nothing touches
    // the gateway or the profile default here.
    expect($currentModel.get()).toBe('claude-sonnet-4.6')
    expect($currentProvider.get()).toBe('anthropic')
    expect(requestGateway).not.toHaveBeenCalled()
    expect(setGlobalModel).not.toHaveBeenCalled()
  })

  it('seeds an empty composer model from global but never clobbers a pick', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ model: 'openai/gpt-5.5', provider: 'openai-codex' })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: null,
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    // Empty → seeds the default.
    await result.current.refreshCurrentModel()
    expect($currentModel.get()).toBe('openai/gpt-5.5')

    // A user pick must survive the lifecycle refreshes that fire on boot / fresh
    // draft / session events.
    setCurrentModel('anthropic/claude-sonnet-4.6')
    setCurrentProvider('anthropic')
    await result.current.refreshCurrentModel()
    expect($currentModel.get()).toBe('anthropic/claude-sonnet-4.6')

    // A profile swap forces a reseed to the new profile's default.
    await result.current.refreshCurrentModel(true)
    expect($currentModel.get()).toBe('openai/gpt-5.5')
  })

  // ── hc-512: catalog validation — a selection outside the catalog is never
  //    applied silently; it falls back to the default with a one-time toast.

  const catalogPayload = {
    model: 'deepseek-v4-pro-APEX',
    provider: 'custom:apex-nodes.com',
    providers: [
      {
        slug: 'custom:apex-nodes.com',
        name: 'Apex-nodes.com',
        is_current: true,
        models: ['deepseek-v4-pro-APEX', 'deepseek-v4-flash']
      }
    ]
  }

  function seededClient() {
    const queryClient = new QueryClient()

    queryClient.setQueryData(['model-options', 'global'], catalogPayload)

    return queryClient
  }

  it('rejects a pre-session pick that is not in the cached catalog and falls back to the default', async () => {
    const requestGateway = vi.fn()

    const { result } = renderHook(() =>
      useModelControls({ activeSessionId: null, queryClient: seededClient(), requestGateway })
    )

    await expect(
      result.current.selectModel({ model: 'ghost-model-1', provider: 'custom:apex-nodes.com' })
    ).resolves.toBe(false)

    // Fallback = the catalog default, applied as plain UI state; the reject is
    // NOT silent (one toast) and never reaches the gateway.
    expect($currentModel.get()).toBe('deepseek-v4-pro-APEX')
    expect($currentProvider.get()).toBe('custom:apex-nodes.com')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('fails open when no catalog is cached yet (pick applies as before)', async () => {
    const requestGateway = vi.fn()

    const { result } = renderHook(() =>
      useModelControls({ activeSessionId: null, queryClient: new QueryClient(), requestGateway })
    )

    await expect(
      result.current.selectModel({ model: 'ghost-model-2', provider: 'anywhere' })
    ).resolves.toBe(true)

    expect($currentModel.get()).toBe('ghost-model-2')
  })

  it('reconciles a stale sticky pick against a fresh catalog exactly once', () => {
    setCurrentModel('ghost-model-3')
    setCurrentProvider('custom:apex-nodes.com')

    const { result } = renderHook(() =>
      useModelControls({ activeSessionId: null, queryClient: seededClient(), requestGateway: vi.fn() })
    )

    result.current.reconcileModelSelection(catalogPayload)

    expect($currentModel.get()).toBe('deepseek-v4-pro-APEX')
    expect($currentProvider.get()).toBe('custom:apex-nodes.com')
    expect(notify).toHaveBeenCalledTimes(1)

    // Same stale id resurfacing must not re-toast (one-time per app run).
    setCurrentModel('ghost-model-3')
    result.current.reconcileModelSelection(catalogPayload)
    expect(notify).toHaveBeenCalledTimes(1)
    expect($currentModel.get()).toBe('deepseek-v4-pro-APEX')
  })

  it('leaves a valid selection alone on reconcile', () => {
    setCurrentModel('deepseek-v4-flash')
    setCurrentProvider('custom:apex-nodes.com')

    const { result } = renderHook(() =>
      useModelControls({ activeSessionId: null, queryClient: seededClient(), requestGateway: vi.fn() })
    )

    result.current.reconcileModelSelection(catalogPayload)

    expect($currentModel.get()).toBe('deepseek-v4-flash')
    expect(notify).not.toHaveBeenCalled()
  })

  it('never reconciles session-scoped state (server-truth)', () => {
    $activeSessionId.set('runtime-9')
    setCurrentModel('ghost-model-4')
    setCurrentProvider('custom:apex-nodes.com')

    const { result } = renderHook(() =>
      useModelControls({ activeSessionId: 'runtime-9', queryClient: seededClient(), requestGateway: vi.fn() })
    )

    result.current.reconcileModelSelection(catalogPayload)

    expect($currentModel.get()).toBe('ghost-model-4')
    expect(notify).not.toHaveBeenCalled()
  })
})
