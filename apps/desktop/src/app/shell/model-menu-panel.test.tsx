import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelControls } from '@/app/session/hooks/use-model-controls'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'

import { ModelMenuPanel } from './model-menu-panel'


const notify = vi.fn((..._args: unknown[]) => 'confirm-toast-1')
const notifyError = vi.fn((..._args: unknown[]) => undefined)
const dismissNotification = vi.fn((..._args: unknown[]) => undefined)

vi.mock('@/store/notifications', () => ({
  dismissNotification: (...args: unknown[]) => dismissNotification(...args),
  notify: (...args: unknown[]) => notify(...args),
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelOptions = vi.fn()
const getMoaModels = vi.fn()
const saveMoaModels = vi.fn()
const setModelAssignment = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: (...args: unknown[]) => getGlobalModelOptions(...args),
  getMoaModels: (...args: unknown[]) => getMoaModels(...args),
  saveMoaModels: (...args: unknown[]) => saveMoaModels(...args),
  setModelAssignment: (...args: unknown[]) => setModelAssignment(...args),
  setApiRequestProfile: vi.fn()
}))

// MoA presets now arrive as the catalog's virtual `moa` provider row (the same
// payload a remote gateway's model.options returns), not the /api/model/moa
// REST config.
const MOA_PROVIDER = { models: ['default', 'BeastMode'], name: 'Mixture of Agents', slug: 'moa' }

const DEEPSEEK_PROVIDER = {
  models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  name: 'DeepSeek',
  slug: 'deepseek'
}

const GOOGLE_PROVIDER = {
  models: ['gemini-3.1-pro', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  name: 'Google',
  slug: 'google'
}

const MOCK_PROVIDERS = [DEEPSEEK_PROVIDER, GOOGLE_PROVIDER, MOA_PROVIDER]

beforeEach(() => {
  $activeSessionId.set('runtime-1')
  $currentModel.set('')
  $currentProvider.set('')
  $collapsedProviders.set([])
  getGlobalModelOptions.mockReset().mockResolvedValue({ providers: MOCK_PROVIDERS })
  getMoaModels.mockReset().mockResolvedValue(null)
  saveMoaModels.mockReset().mockImplementation((config: unknown) => Promise.resolve({ ...(config as object), ok: true }))
  setModelAssignment.mockReset().mockResolvedValue({ ok: true })
  notifyError.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(onSelectModel = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const content = render(
    <QueryClientProvider client={client}>
      <DropdownMenu open>
        <DropdownMenuContent>
          <ModelMenuPanel onSelectModel={onSelectModel} requestGateway={vi.fn() as never} />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>
  )

  return { onSelectModel, content }
}

// Radix DropdownMenu portals its content to document.body, so these assert
// against the body (not content.container) to see the rendered items.
describe('ModelMenuPanel China-first + invisible MoA', () => {
  it('never names MoA, even though the catalog ships the virtual provider row', async () => {
    // MOA-INVISIBLE-DESIGN: upstream lists the `moa` row's models as named
    // presets ("MoA presets" / "MoA: BeastMode"). Multi-select composes the
    // same thing silently, so none of that vocabulary may reach the menu.
    const { content } = renderPanel()

    await content.findByText('DeepSeek')

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toMatch(/mixture of agents|aggregator|preset|__auto__|\bmoa\b/i)
  })

  it('hides foreign providers the user cannot reach from the mainland', async () => {
    const { content } = renderPanel()

    await content.findByText('DeepSeek')

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toContain('Google')
    expect(content.queryByText('Gemini 3.1 Pro')).toBeNull()
  })
})

describe('ModelMenuPanel provider collapse', () => {
  it('shows all provider models by default (none collapsed)', async () => {
    const { content } = renderPanel()

    await content.findByText('DeepSeek')
    expect(content.queryByText('DeepSeek V4 Pro')).not.toBeNull()
    expect(content.queryByText('DeepSeek Chat')).not.toBeNull()
  })

  it('collapses provider models when header is clicked', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)

    // Models should disappear but header stays
    expect(content.queryByText('DeepSeek V4 Pro')).toBeNull()
    expect(content.queryByText('DeepSeek')).not.toBeNull()
  })

  it('expands provider models when header is clicked again', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    // Collapse
    fireEvent.click(header)
    expect(content.queryByText('DeepSeek V4 Pro')).toBeNull()
    // Expand
    fireEvent.click(header)
    await vi.waitFor(() => {
      expect(content.queryByText('DeepSeek V4 Pro')).not.toBeNull()
    })
  })

  it('auto-expands the active provider even when collapsed', async () => {
    $currentProvider.set('deepseek')
    $currentModel.set('deepseek-v4-pro')
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)

    // Should still show models because it's the active provider
    expect(content.queryByText('DeepSeek V4 Pro')).not.toBeNull()
  })

  it('bypasses collapse when search is active', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)
    expect(content.queryByText('DeepSeek V4 Pro')).toBeNull()

    // Type in the search bar (auto-focused by DropdownMenuSearch)
    const input = screen.getByRole('textbox', { name: 'Search models' })
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: 'deepseek' } })

    // Should show models — search bypasses collapse
    await vi.waitFor(() => {
      expect(content.queryByText('DeepSeek V4 Pro')).not.toBeNull()
    })
  })

  it('toggles collapse via keyboard Enter on header', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    // Radix DropdownMenuItem fires onSelect on Enter from the onKeyDown handler
    fireEvent.keyDown(header.closest('[role="menuitem"]') ?? header, { key: 'Enter' })

    expect(content.queryByText('DeepSeek V4 Pro')).toBeNull()
  })

  // The collapsed-providers set is a global presentation preference
  // (`hermes.desktop.collapsed-providers`), but the catalog the picker renders
  // is profile-scoped (`getGlobalModelOptions` routes through
  // `profileScoped()`). Pruning the global set against only the active catalog
  // would silently delete a user's collapse preference on every profile switch
  // whose configured providers don't include the slug — the bug the maintainer
  // flagged. The set must survive catalog changes; if the same provider shows
  // up again later, the previous collapse is preserved.
  it('preserves the collapsed set across a profile switch whose catalog lacks the slug', async () => {
    toggleCollapsedProvider('deepseek')
    toggleCollapsedProvider('google')
    expect($collapsedProviders.get()).toEqual(['deepseek', 'google'])

    // Profile A: both providers present, render + unmount.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: MOCK_PROVIDERS })
    const a = renderPanel()
    await a.content.findByText('DeepSeek')
    a.content.unmount()

    // Profile B: google is not in the catalog (simulates a profile whose
    // configured providers differ). The previously-collapsed 'google' slug
    // must survive — pruning it would lose state across a profile switch.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [DEEPSEEK_PROVIDER, MOA_PROVIDER] })
    const b = renderPanel()
    await b.content.findByText('DeepSeek')

    expect($collapsedProviders.get()).toEqual(['deepseek', 'google'])
  })

  it('preserves the collapsed set when Refresh Models drops a provider', async () => {
    toggleCollapsedProvider('deepseek')
    toggleCollapsedProvider('google')

    // First load: both providers present.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: MOCK_PROVIDERS })
    const a = renderPanel()
    await a.content.findByText('DeepSeek')
    a.content.unmount()

    // Refresh Models returns a catalog that drops google (revoked key,
    // plugin disabled, backend policy change). 'google' must survive — the
    // user explicitly collapsed it, and the global set is not tied to any
    // single refresh.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [DEEPSEEK_PROVIDER, MOA_PROVIDER] })
    const b = renderPanel()
    await b.content.findByText('DeepSeek')

    expect($collapsedProviders.get()).toContain('google')
    expect($collapsedProviders.get()).toContain('deepseek')
  })

  it('switches the session model when Refresh Models drops the current pick', async () => {
    $currentProvider.set('zai')
    $currentModel.set('glm-4.5-air')
    getGlobalModelOptions
      .mockResolvedValueOnce({
        model: 'glm-4.5-air',
        provider: 'zai',
        providers: [{ models: ['glm-4.5-air', 'glm-5-turbo'], name: '智谱2', slug: 'zai' }, MOA_PROVIDER]
      })
      .mockResolvedValueOnce({
        model: 'glm-4.5-air',
        provider: 'zai',
        providers: [DEEPSEEK_PROVIDER, MOA_PROVIDER]
      })

    const { content, onSelectModel } = renderPanel()

    await content.findByText(/Glm 4\.5 Air/i)

    fireEvent.click(await content.findByText('Refresh Models'))

    await vi.waitFor(() => {
      expect(onSelectModel).toHaveBeenCalledWith({
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        sessionId: 'runtime-1'
      })
    })
  })

  it('does not switch when Refresh Models still lists the current pick', async () => {
    $currentProvider.set('deepseek')
    $currentModel.set('deepseek-v4-pro')
    getGlobalModelOptions.mockResolvedValue({ providers: MOCK_PROVIDERS })

    const { content, onSelectModel } = renderPanel()

    await content.findByText(/Deepseek V4 Pro/i)
    fireEvent.click(await content.findByText('Refresh Models'))

    await vi.waitFor(() => {
      expect(getGlobalModelOptions).toHaveBeenCalledTimes(2)
    })
    expect(onSelectModel).not.toHaveBeenCalled()
  })
})

describe('ModelMenuPanel refresh reconcile × guarded-switch confirm handshake', () => {
  // #95446 fix (reconcile after Refresh Models) composes with the
  // confirm-handshake guard: when the reconcile target is itself a GUARDED
  // model (contributor tier / expensive), the switch must surface the confirm
  // flow — one config.set, a warning with a Confirm action, rollback until
  // confirmed — never a silent retry loop and never a silently-painted pick.
  function ConfirmHarness({
    requestGateway
  }: {
    requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  }) {
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    const controls = useModelControls({ queryClient: client, requestGateway })

    return (
      <QueryClientProvider client={client}>
        <DropdownMenu open>
          <DropdownMenuContent>
            <ModelMenuPanel onSelectModel={controls.selectModel} requestGateway={requestGateway as never} />
          </DropdownMenuContent>
        </DropdownMenu>
      </QueryClientProvider>
    )
  }

  it('reconcile-triggered switch to a guarded model surfaces confirm, not a silent retry', async () => {
    $activeSessionId.set('runtime-1')
    $currentProvider.set('zai')
    $currentModel.set('glm-4.5-air')
    getGlobalModelOptions
      .mockResolvedValueOnce({
        providers: [{ models: ['glm-4.5-air'], name: 'Zhipu', slug: 'zai' }, MOA_PROVIDER]
      })
      // Refresh drops the current pick; the only remaining model is guarded.
      .mockResolvedValueOnce({
        providers: [{ models: ['muse-spark-1.2-contributor'], name: 'OpenCode', slug: 'opencode-go' }, MOA_PROVIDER]
      })

    // Method-aware gateway: the panel's catalog reads (`model.options`) fall
    // back to the REST mock; `config.set` runs the guarded handshake —
    // confirm_required first, success on the confirmed resend.
    let configSets = 0

    const requestGateway = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method !== 'config.set') {
        throw new Error('use REST catalog')
      }

      configSets += 1

      if (configSets === 1) {
        return {
          confirm_message: 'CONTRIBUTOR TIER: this model may train on your data.',
          confirm_required: true,
          key: 'model',
          value: 'muse-spark-1.2-contributor'
        }
      }

      return { key: 'model', scope: 'global', value: 'muse-spark-1.2-contributor' }
    })

    const content = render(<ConfirmHarness requestGateway={requestGateway as never} />)

    await content.findByText(/Glm 4\.5 Air/i)
    fireEvent.click(await content.findByText('Refresh Models'))

    // The reconcile fired exactly ONE switch attempt and it came back
    // confirm_required → the confirm toast is up, nothing retried silently.
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ label: expect.any(String) }),
          kind: 'warning',
          message: 'CONTRIBUTOR TIER: this model may train on your data.'
        })
      )
    })

    const configSetCalls = requestGateway.mock.calls.filter(([method]) => method === 'config.set')
    expect(configSetCalls).toHaveLength(1)
    expect(configSetCalls[0][1]).not.toHaveProperty('confirm_expensive_model')

    // Pending confirmation = rolled back, not silently painted.
    expect($currentModel.get()).toBe('glm-4.5-air')
    expect($currentProvider.get()).toBe('zai')

    // User confirms → ONE resend carrying confirm_expensive_model: true.
    const lastNotify = notify.mock.calls.at(-1)?.[0] as { action: { onClick: () => Promise<void> } }

    await act(async () => {
      await lastNotify.action.onClick()
    })

    await vi.waitFor(() => {
      const resend = requestGateway.mock.calls.filter(([method]) => method === 'config.set')
      expect(resend).toHaveLength(2)
      expect(resend[1][1]).toMatchObject({ confirm_expensive_model: true, session_id: 'runtime-1' })
    })
    expect($currentModel.get()).toBe('muse-spark-1.2-contributor')
    expect($currentProvider.get()).toBe('opencode-go')
    expect(notifyError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// hc-598 — one endpoint, one row, in product language
// ---------------------------------------------------------------------------

// The managed relay is registered under the BARE `custom` slug with a named
// `custom_providers` entry beside it, so the runtime lists the endpoint as
// `custom:apex-nodes.com` AND synthesizes a second, anonymous row for the
// "missing" bare slug (hermes_cli/inventory.py `_append_unconfigured_rows`).
const RELAY_PROVIDER = {
  api_url: 'https://apex-nodes.com/relay/v1',
  models: ['deepseek-v4-pro-APEX', 'glm-5.2', 'qwen3.7-max'],
  name: 'Apex-nodes.com',
  slug: 'custom:apex-nodes.com'
}

const RELAY_ALIAS_ROW = {
  authenticated: false,
  models: ['deepseek-v4-pro-APEX'],
  name: 'Custom endpoint',
  slug: 'custom',
  warning: 'Configured provider is not authenticated; run `hermes model` to reactivate.'
}

describe('ModelMenuPanel endpoint naming', () => {
  it('never shows the implementation word, and lists one endpoint once', async () => {
    getGlobalModelOptions.mockResolvedValue({ providers: [RELAY_PROVIDER, RELAY_ALIAS_ROW, MOA_PROVIDER] })

    const { content } = renderPanel()

    await content.findByText('Apex-nodes.com')

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toMatch(/custom endpoint/i)
    // One section header for the endpoint, not two.
    expect(content.queryAllByText('Apex-nodes.com')).toHaveLength(1)
    // …and its single model isn't duplicated by the alias row either.
    expect(content.queryAllByText('DeepSeek V4 Pro')).toHaveLength(1)
  })

  it('names an unnamed endpoint by its address rather than by its slug', async () => {
    // A user's own OpenAI-compatible endpoint: no named `custom_providers`
    // entry, so the runtime labels the row "Custom endpoint".
    getGlobalModelOptions.mockResolvedValue({
      providers: [{ api_url: 'http://127.0.0.1:11434/v1', models: ['qwen3'], name: 'Custom endpoint', slug: 'custom' }]
    })

    const { content } = renderPanel()

    await content.findByText('127.0.0.1:11434')

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toMatch(/custom endpoint/i)
  })
})

// ---------------------------------------------------------------------------
// hc-599 — rapid multi-select must not lose a checkmark
// ---------------------------------------------------------------------------

/** Display names of the rows currently showing a check mark. The name is the
 *  row label's first text node — the trailing effort/fast meta is a sibling. */
function checkedRows(): string[] {
  // eslint-disable-next-line no-restricted-globals
  return Array.from(document.querySelectorAll('.codicon-check'))
    .map(
      icon =>
        icon.closest('[role="menuitem"]')?.querySelector('span.truncate')?.childNodes[0]?.textContent?.trim() ?? ''
    )
    .filter(Boolean)
}

/** A promise plus its resolve/reject handles, for ordering async writes by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, reject, resolve }
}

/** Member model ids of the last composed preset handed to saveMoaModels. */
function lastSavedMembers(): string[] {
  const config = saveMoaModels.mock.calls.at(-1)?.[0] as
    | { presets: Record<string, { aggregator: { model: string }; reference_models: { model: string }[] }> }
    | undefined

  const preset = config?.presets?.__auto__

  if (!preset) {
    return []
  }

  return [preset.aggregator.model, ...preset.reference_models.map(slot => slot.model)].sort()
}

describe('ModelMenuPanel multi-select commits on dismiss (hc-637)', () => {
  beforeEach(() => {
    getGlobalModelOptions.mockResolvedValue({ providers: [RELAY_PROVIDER, MOA_PROVIDER] })
  })

  async function openWithRelayRows(onSelectModel = vi.fn()) {
    const rendered = renderPanel(onSelectModel)

    await rendered.content.findByText('Apex-nodes.com')
    await rendered.content.findByText('GLM 5.2')

    return rendered
  }

  /** Let queued microtasks drain. */
  const settle = () => act(async () => undefined)

  /** Dismissing the menu unmounts the panel — that IS the commit. */
  const dismiss = async (content: ReturnType<typeof renderPanel>['content']) => {
    content.unmount()
    await settle()
  }

  it('writes nothing while the menu is open', async () => {
    // The core of hc-637. Writing per click put three things in contention —
    // the user's clicks, a serialized write chain, and a seed effect reading a
    // server snapshot taken mid-write. Staging removes the contention by
    // removing the in-flight write.
    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    await settle()
    fireEvent.click(content.getByText('GLM 5.2'))
    await settle()
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()

    expect(saveMoaModels).not.toHaveBeenCalled()
    expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'GLM 5.2', 'Qwen3.7 Max'])
  })

  it('commits once on dismiss, carrying the final set', async () => {
    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    fireEvent.click(content.getByText('GLM 5.2'))
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()

    await dismiss(content)

    await vi.waitFor(() => expect(saveMoaModels).toHaveBeenCalledTimes(1))
    expect(lastSavedMembers()).toEqual(['deepseek-v4-pro', 'glm-5.2', 'qwen3.7-max'])
  })

  it('toggling a model back off before dismissing leaves it out of the write', async () => {
    // Staging means intermediate states never reach the server: only what the
    // user is looking at when the menu closes does.
    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    fireEvent.click(content.getByText('GLM 5.2'))
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    fireEvent.click(content.getByText('GLM 5.2'))
    await settle()

    await dismiss(content)

    await vi.waitFor(() => expect(saveMoaModels).toHaveBeenCalledTimes(1))
    expect(lastSavedMembers()).toEqual(['deepseek-v4-pro', 'qwen3.7-max'])
  })

  it('opening and closing without touching anything writes nothing', async () => {
    // Committing on dismiss must not turn every glance at the menu into a
    // model switch — the commit diffs against what was seeded.
    const { content, onSelectModel } = await openWithRelayRows()

    await dismiss(content)

    expect(saveMoaModels).not.toHaveBeenCalled()
    expect(onSelectModel).not.toHaveBeenCalled()
  })

  it('reopening an existing composition and closing it writes nothing', async () => {
    // The empty-seed case above cannot reach the "did anything change?" guard —
    // it returns earlier, on the empty set. This is the case that needs it: a
    // real selection is seeded, the user only looks, and dismissing must not
    // re-write (which would churn the profile and the agent on every glance).
    getMoaModels.mockResolvedValue({
      active_preset: '__auto__',
      default_preset: '__auto__',
      presets: {
        __auto__: {
          aggregator: { model: 'qwen3.7-max', provider: 'custom:apex-nodes.com' },
          reference_models: [{ model: 'glm-5.2', provider: 'custom:apex-nodes.com' }]
        }
      }
    })
    $currentProvider.set('moa')
    $currentModel.set('__auto__')

    const { content, onSelectModel } = await openWithRelayRows()

    await vi.waitFor(() => expect(checkedRows()).toEqual(['GLM 5.2', 'Qwen3.7 Max']))
    await dismiss(content)

    expect(saveMoaModels).not.toHaveBeenCalled()
    expect(onSelectModel).not.toHaveBeenCalled()
  })

  it('a single staged model commits through the session path, not a profile write', async () => {
    const { content, onSelectModel } = await openWithRelayRows()

    fireEvent.click(content.getByText('GLM 5.2'))
    await settle()
    await dismiss(content)

    await vi.waitFor(() => expect(onSelectModel).toHaveBeenCalled())
    expect(saveMoaModels).not.toHaveBeenCalled()
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('a composition is assigned at SESSION scope, like a single pick', async () => {
    // The bug this fixes: the composition was written with
    // setModelAssignment({ scope: 'main' }) — the profile default — while a
    // single pick wrote a session override. A session override shadows the
    // profile default, so on any session that had ever had a model picked the
    // composition was stored and had no effect: the pill kept the old single
    // model and reopening collapsed back to one checkmark, with no error
    // anywhere because neither write failed.
    const { content, onSelectModel } = await openWithRelayRows()

    fireEvent.click(content.getByText('GLM 5.2'))
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()
    await dismiss(content)

    await vi.waitFor(() => expect(saveMoaModels).toHaveBeenCalledTimes(1))
    expect(setModelAssignment).not.toHaveBeenCalled()
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ model: '__auto__', provider: 'moa' }))
  })

  it('seeds from the saved preset when the menu opens, then leaves it alone', async () => {
    // Unchanged contract: the composed selection lives in the profile's
    // `__auto__` preset, and the menu must show it back on open.
    getMoaModels.mockResolvedValue({
      active_preset: '__auto__',
      default_preset: '__auto__',
      presets: {
        __auto__: {
          aggregator: { model: 'qwen3.7-max', provider: 'custom:apex-nodes.com' },
          reference_models: [{ model: 'glm-5.2', provider: 'custom:apex-nodes.com' }]
        }
      }
    })
    $currentProvider.set('moa')
    $currentModel.set('__auto__')

    const { content } = await openWithRelayRows()

    await vi.waitFor(() => expect(checkedRows()).toEqual(['GLM 5.2', 'Qwen3.7 Max']))

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    await settle()

    expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'GLM 5.2', 'Qwen3.7 Max'])
  })

  it('a failed commit surfaces the error instead of failing silently', async () => {
    // The panel is gone by the time the write runs, so there are no checkmarks
    // to roll back — the user must at least be told.
    saveMoaModels.mockRejectedValue(new Error('relay rejected the preset'))

    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('GLM 5.2'))
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()
    await dismiss(content)

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalled())
  })
})
