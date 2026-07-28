import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $visibleModels, modelVisibilityKey, setVisibleModels } from '@/store/model-visibility'

import { ModelVisibilityDialog } from './model-visibility-dialog'

const getGlobalModelOptions = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: (...args: unknown[]) => getGlobalModelOptions(...args)
}))

const MANAGED = 'custom:apex-nodes.com'

// The row the runtime synthesizes from config["moa"].presets — every
// model.options payload carries it, including the reserved `__auto__` preset
// the silent multi-select writes (hermes_cli/inventory.py _moa_provider_row).
const MOA_PROVIDER = {
  models: ['default', 'apex-moa', 'apex-moa-qwen', '__auto__'],
  name: 'Mixture of Agents',
  slug: 'moa'
}

const MANAGED_PROVIDER = {
  models: ['deepseek-v4-pro-APEX', 'glm-5.2', 'qwen3.7-max'],
  name: 'Apex-nodes.com',
  slug: MANAGED
}

const DEEPSEEK_PROVIDER = { models: ['deepseek-v4-pro', 'deepseek-chat'], name: 'DeepSeek', slug: 'deepseek' }

beforeEach(() => {
  // null = "user has never customized", the state the curated defaults expand
  // from. Set directly: setVisibleModels(new Set()) means "hid everything".
  $visibleModels.set(null)
  window.localStorage.clear()
  getGlobalModelOptions.mockResolvedValue({ providers: [MOA_PROVIDER, MANAGED_PROVIDER, DEEPSEEK_PROVIDER] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <I18nProvider configClient={null}>
      <QueryClientProvider client={client}>
        <ModelVisibilityDialog onOpenChange={vi.fn()} onOpenProviders={vi.fn()} open />
      </QueryClientProvider>
    </I18nProvider>
  )
}

// Radix Dialog portals its content to document.body, so the vocabulary
// assertions read the body rather than the render container.
describe('ModelVisibilityDialog invisible MoA (hc-596)', () => {
  it('never names MoA, even though the catalog ships the virtual provider row', async () => {
    // MOA-INVISIBLE-DESIGN: this dialog used to render that row like any other
    // provider — a "MIXTURE OF AGENTS" heading over `default` / `apex-moa` /
    // `__auto__`, each with its own visibility switch. Flipping
    // SHOW_EXPLICIT_MOA_UI restores upstream's row and turns this red.
    renderDialog()
    await screen.findByText('Apex-nodes.com')

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toMatch(/mixture of agents|aggregator|reference|preset|__auto__|\bmoa\b/i)
  })

  it('still lists every real provider and its models', async () => {
    renderDialog()
    await screen.findByText('Apex-nodes.com')

    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByText('GLM 5.2')).toBeTruthy()
    // The managed default renders as name + brand tag, not the raw sentinel id;
    // the BYO DeepSeek row carries the same name, so both are present.
    expect(screen.getAllByText('DeepSeek V4 Pro')).toHaveLength(2)
  })

  it('keeps one row per provider — two distinct custom endpoints stay two rows', async () => {
    // Guards the boundary of the MoA filter: only the virtual `moa` row is
    // dropped. A user with the managed relay AND their own OpenAI-compatible
    // endpoint has two real endpoints, and both must keep their own section
    // even when they serve an identically-named model.
    getGlobalModelOptions.mockResolvedValue({
      providers: [MOA_PROVIDER, MANAGED_PROVIDER, { models: ['glm-5.2'], name: 'My proxy', slug: 'custom:my-proxy' }]
    })

    renderDialog()
    await screen.findByText('Apex-nodes.com')

    expect(screen.getByText('My proxy')).toBeTruthy()
    expect(screen.getAllByText('GLM 5.2')).toHaveLength(2)
  })

  it('leaves no MoA keys in the persisted visibility set', async () => {
    // The stored set is seeded from the rendered provider list, so a leaked
    // `moa` row would also write `moa::__auto__` into localStorage — a preset
    // name persisted on disk, and a visibility entry the composer picker (which
    // never sees the row) can never act on.
    renderDialog()
    await screen.findByText('Apex-nodes.com')

    fireEvent.click(screen.getAllByRole('switch')[0])

    const stored = [...($visibleModels.get() ?? [])]
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.some(key => key.startsWith('moa::'))).toBe(false)
  })
})

describe('ModelVisibilityDialog visibility toggles', () => {
  it('persists a hidden model across a remount', async () => {
    const key = modelVisibilityKey(MANAGED, 'glm-5.2')

    const first = renderDialog()
    await first.findByText('Apex-nodes.com')

    const glmSwitch = screen.getByText('GLM 5.2').closest('label')!.querySelector('button')!
    expect(glmSwitch.getAttribute('data-state')).toBe('checked')

    fireEvent.click(glmSwitch)
    expect($visibleModels.get()!.has(key)).toBe(false)
    expect(window.localStorage.getItem('hermes.desktop.visible-models')).not.toContain('glm-5.2')

    cleanup()
    renderDialog()
    await screen.findByText('Apex-nodes.com')

    expect(screen.getByText('GLM 5.2').closest('label')!.querySelector('button')!.getAttribute('data-state')).toBe(
      'unchecked'
    )
  })

  it('re-enabling a hidden model restores its switch', async () => {
    setVisibleModels(new Set([modelVisibilityKey(MANAGED, 'deepseek-v4-pro-APEX')]))

    renderDialog()
    await screen.findByText('Apex-nodes.com')

    const glmSwitch = screen.getByText('GLM 5.2').closest('label')!.querySelector('button')!
    expect(glmSwitch.getAttribute('data-state')).toBe('unchecked')

    fireEvent.click(glmSwitch)
    expect($visibleModels.get()!.has(modelVisibilityKey(MANAGED, 'glm-5.2'))).toBe(true)
  })
})

// hc-598: the managed relay is registered under the BARE `custom` slug with a
// named `custom_providers` entry beside it, so the runtime lists the endpoint
// once as `custom:apex-nodes.com` and then synthesizes a second, anonymous row
// for the "missing" bare slug (hermes_cli/inventory.py
// `_append_unconfigured_rows`). Here that opened a whole extra "CUSTOM
// ENDPOINT" section, with its own visibility switches, for an endpoint already
// listed above under its real name.
describe('ModelVisibilityDialog one endpoint one section (hc-598)', () => {
  const RELAY_ALIAS_ROW = {
    authenticated: false,
    models: ['deepseek-v4-pro-APEX'],
    name: 'Custom endpoint',
    slug: 'custom',
    warning: 'Configured provider is not authenticated; run `hermes model` to reactivate.'
  }

  it('drops the anonymous alias of an endpoint already listed by name', async () => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [MOA_PROVIDER, MANAGED_PROVIDER, RELAY_ALIAS_ROW, DEEPSEEK_PROVIDER]
    })

    renderDialog()
    await screen.findByText('Apex-nodes.com')

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toMatch(/custom endpoint/i)
    // The relay's default model appears once for the relay and once for the
    // BYO DeepSeek row — the alias would have made it three.
    expect(screen.getAllByText('DeepSeek V4 Pro')).toHaveLength(2)
  })

  it('keeps a bare custom row that is the only face of a real endpoint', async () => {
    // A user's own OpenAI-compatible endpoint with no named entry: this row IS
    // the endpoint, so it must keep its section — named by its address.
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        MOA_PROVIDER,
        DEEPSEEK_PROVIDER,
        { api_url: 'http://127.0.0.1:11434/v1', models: ['qwen3'], name: 'Custom endpoint', slug: 'custom' }
      ]
    })

    renderDialog()
    await screen.findByText('127.0.0.1:11434')

    expect(screen.getByText('Qwen3')).toBeTruthy()
    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toMatch(/custom endpoint/i)
  })
})
