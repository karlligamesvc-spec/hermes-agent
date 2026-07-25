import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: (...args: unknown[]) => getGlobalModelOptions(...args),
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
