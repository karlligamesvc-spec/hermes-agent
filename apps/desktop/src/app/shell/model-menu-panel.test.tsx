import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'

import { ModelMenuPanel } from './model-menu-panel'

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
  getGlobalModelOptions.mockResolvedValue({ providers: MOCK_PROVIDERS })
  getMoaModels.mockResolvedValue(null)
  saveMoaModels.mockImplementation((config: unknown) => Promise.resolve({ ...(config as object), ok: true }))
  setModelAssignment.mockResolvedValue({ ok: true })
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

describe('ModelMenuPanel multi-select under rapid clicks', () => {
  beforeEach(() => {
    getGlobalModelOptions.mockResolvedValue({ providers: [RELAY_PROVIDER, MOA_PROVIDER] })
  })

  async function openWithRelayRows() {
    const rendered = renderPanel()

    await rendered.content.findByText('Apex-nodes.com')
    await rendered.content.findByText('GLM 5.2')

    return rendered
  }

  /** Let the queued write chain advance past its pending microtasks. */
  const settle = () => act(async () => undefined)

  it('keeps the earlier model checked when the next is clicked mid-save', async () => {
    // The bug: every click wrote the saved MoA config into the query cache and
    // invalidated the catalog, which re-ran the selection backfill and replaced
    // the local set with a SERVER snapshot taken mid-write — so clicking the
    // third model unchecked the second.
    const held = deferred<unknown>()
    saveMoaModels
      .mockImplementationOnce(config => held.promise.then(() => ({ ...(config as object), ok: true })))
      .mockImplementation(config => Promise.resolve({ ...(config as object), ok: true }))

    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    await settle()
    fireEvent.click(content.getByText('GLM 5.2'))
    await settle()
    // Third click lands while the second's save is still open.
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()

    expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'GLM 5.2', 'Qwen3.7 Max'])

    held.resolve(null)

    await vi.waitFor(() => expect(lastSavedMembers()).toEqual(['deepseek-v4-pro', 'glm-5.2', 'qwen3.7-max']))
    expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'GLM 5.2', 'Qwen3.7 Max'])
  })

  it('coalesces a burst into one write carrying the final set', async () => {
    const { content } = await openWithRelayRows()

    // Three clicks with no chance for the queue to drain between them.
    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    fireEvent.click(content.getByText('GLM 5.2'))
    fireEvent.click(content.getByText('Qwen3.7 Max'))

    await vi.waitFor(() => expect(saveMoaModels).toHaveBeenCalledTimes(1))
    expect(lastSavedMembers()).toEqual(['deepseek-v4-pro', 'glm-5.2', 'qwen3.7-max'])
    expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'GLM 5.2', 'Qwen3.7 Max'])
  })

  it('serializes the writes so the server ends up holding the last intent', async () => {
    const first = deferred<unknown>()
    saveMoaModels
      .mockImplementationOnce(config => first.promise.then(() => ({ ...(config as object), ok: true })))
      .mockImplementation(config => Promise.resolve({ ...(config as object), ok: true }))

    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    await settle()
    fireEvent.click(content.getByText('GLM 5.2'))
    await settle()
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()

    // The held write is still the only one that has started — the second is
    // queued behind it rather than racing it.
    expect(saveMoaModels).toHaveBeenCalledTimes(1)

    first.resolve(null)

    await vi.waitFor(() => expect(lastSavedMembers()).toEqual(['deepseek-v4-pro', 'glm-5.2', 'qwen3.7-max']))
  })

  it('rolls back only the failed write, not the selection made while it was open', async () => {
    const failing = deferred<unknown>()
    saveMoaModels
      .mockImplementationOnce(() => failing.promise)
      .mockImplementation(config => Promise.resolve({ ...(config as object), ok: true }))

    const { content } = await openWithRelayRows()

    fireEvent.click(content.getByText('DeepSeek V4 Pro'))
    await settle()
    // This click's write is the one that fails.
    fireEvent.click(content.getByText('GLM 5.2'))
    await settle()
    // …and this one arrives while that write is open, so it is NOT its to undo.
    fireEvent.click(content.getByText('Qwen3.7 Max'))
    await settle()

    failing.reject(new Error('relay rejected the preset'))

    // GLM comes back off; DeepSeek (already persisted) and Qwen (a later
    // intent) both survive, and the corrected set is what gets written next.
    await vi.waitFor(() => expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'Qwen3.7 Max']))
    await vi.waitFor(() => expect(lastSavedMembers()).toEqual(['deepseek-v4-pro', 'qwen3.7-max']))
  })

  it('seeds from the saved preset when the menu opens, then leaves it alone', async () => {
    // The composed selection lives in the profile's `__auto__` preset, but the
    // gateway answers model.options with the AGENT's single live model — so a
    // mirror of the server would collapse the set every time the catalog
    // refreshed, which every write triggers.
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

    // The write's cache update + catalog invalidation must not re-seed over it.
    await vi.waitFor(() => expect(saveMoaModels).toHaveBeenCalled())
    await settle()
    expect(checkedRows()).toEqual(['DeepSeek V4 Pro', 'GLM 5.2', 'Qwen3.7 Max'])
  })
})
