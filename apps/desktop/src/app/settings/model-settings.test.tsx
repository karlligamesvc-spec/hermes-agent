import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix Select calls scrollIntoView on its items when the content opens; jsdom
// doesn't implement it (nor hasPointerCapture / releasePointerCapture), so stub
// them to let the dropdown open in tests.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelInfo = vi.fn()
const getGlobalModelOptions = vi.fn()
const getAuxiliaryModels = vi.fn()
const getMoaModels = vi.fn()
const setModelAssignment = vi.fn()
const getRecommendedDefaultModel = vi.fn()
const saveMoaModels = vi.fn()
const setEnvVar = vi.fn()
const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()
const startManualLocalEndpoint = vi.fn()
const startManualOnboarding = vi.fn()
const startManualProviderOAuth = vi.fn()
let profileSwitchHandler: (() => void) | null = null

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: (profile?: null | string) => getGlobalModelInfo(profile),
  getGlobalModelOptions: (opts?: unknown, profile?: null | string) => getGlobalModelOptions(opts, profile),
  getAuxiliaryModels: (profile?: null | string) => getAuxiliaryModels(profile),
  getApiRequestProfile: () => 'default',
  getMoaModels: (profile?: null | string) => getMoaModels(profile),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  setModelAssignment: (body: unknown) => setModelAssignment(body),
  getRecommendedDefaultModel: (slug: string) => getRecommendedDefaultModel(slug),
  saveMoaModels: (body: unknown) => saveMoaModels(body),
  setEnvVar: (key: string, value: string) => setEnvVar(key, value),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  saveHermesConfig: (config: unknown) => saveHermesConfig(config),
  setApiRequestProfile: () => {}
}))

vi.mock('@/store/onboarding', () => ({
  startManualLocalEndpoint: () => startManualLocalEndpoint(),
  startManualOnboarding: () => startManualOnboarding(),
  startManualProviderOAuth: (slug: string) => startManualProviderOAuth(slug)
}))

vi.mock('../hooks/use-on-profile-switch', () => ({
  useOnProfileSwitch: (handler: () => void) => {
    profileSwitchHandler = handler
  }
}))

beforeEach(() => {
  getGlobalModelInfo.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        name: 'DeepSeek',
        slug: 'deepseek',
        models: ['deepseek-v4-pro', 'deepseek-chat'],
        authenticated: true,
        capabilities: { 'deepseek-v4-pro': { reasoning: true, fast: true } }
      }
    ]
  })
  getAuxiliaryModels.mockResolvedValue({
    main: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
  })
  getMoaModels.mockResolvedValue(null)
  setModelAssignment.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-v4-pro', gateway_tools: [] })
  getRecommendedDefaultModel.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-v4-pro', free_tier: null })
  setEnvVar.mockResolvedValue({ ok: true })
  getHermesConfigRecord.mockResolvedValue({ agent: { reasoning_effort: 'medium', service_tier: 'normal' } })
  saveHermesConfig.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  profileSwitchHandler = null
})

async function renderModelSettings(scopeProfile?: string) {
  const { ModelSettings } = await import('./model-settings')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    // The aux-task deep-link highlight reads useSearchParams, so the page
    // needs a router context in tests (the app provides HashRouter at root).
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ModelSettings scopeProfile={scopeProfile} />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('ModelSettings profile scope', () => {
  // #90549: the API helpers treat `null` as "deliberately target the
  // primary/default profile". A page following the active profile must pass
  // `undefined`, or every read repaints the primary's model and the user's
  // change looks reverted.
  it('follows the active profile (undefined, never null) when unscoped', async () => {
    await renderModelSettings()

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledWith(undefined))
    expect(getGlobalModelOptions).toHaveBeenCalledWith(undefined, undefined)
    expect(getAuxiliaryModels).toHaveBeenCalledWith(undefined)
    expect(getMoaModels).toHaveBeenCalledWith(undefined)
  })

  it('reads through the explicit scope override when one is set', async () => {
    await renderModelSettings('research')

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledWith('research'))
    expect(getGlobalModelOptions).toHaveBeenCalledWith(undefined, 'research')
    expect(getAuxiliaryModels).toHaveBeenCalledWith('research')
    expect(getMoaModels).toHaveBeenCalledWith('research')
  })
})

describe('ModelSettings', () => {
  it('loads the current main model and lists configured providers only', async () => {
    await renderModelSettings()

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())
    await waitFor(() => expect(getGlobalModelOptions).toHaveBeenCalled())

    // Open the provider Select — only configured providers should be listed.
    const triggers = await screen.findAllByRole('combobox')
    fireEvent.click(triggers[0])

    // "DeepSeek" shows in both the trigger and the open list.
    expect((await screen.findAllByText('DeepSeek')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/MiniMax/)).toBeNull()
  })

  // hc-598: the label is the product name for the row, not its slug — the bare
  // `custom` slug is an implementation word and never reaches the user, so it
  // renders as the neutral "your endpoint" instead. Named/self-describing slugs
  // still show themselves.
  it.each([
    ['custom', 'Your endpoint'],
    ['local', 'local'],
    ['custom:lab', 'custom:lab']
  ])('opens local endpoint setup when %s has no inventory row', async (provider, label) => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider, model: '' })
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [] })

    await renderModelSettings()

    const providerSelect = (await screen.findAllByRole('combobox'))[0]

    expect(providerSelect.textContent).toContain(label)
    expect(screen.queryByText(/undefined/)).toBeNull()
    expect(screen.queryByText(/signs in through your browser/)).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Set up provider' }))

    expect(startManualLocalEndpoint).toHaveBeenCalledOnce()
    expect(startManualOnboarding).not.toHaveBeenCalled()
    expect(startManualProviderOAuth).not.toHaveBeenCalled()
  })

  it('opens the generic provider picker for an unknown provider with no inventory row', async () => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'retired-provider', model: '' })
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [] })

    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Set up provider' }))

    expect(startManualOnboarding).toHaveBeenCalledOnce()
    expect(startManualLocalEndpoint).not.toHaveBeenCalled()
    expect(startManualProviderOAuth).not.toHaveBeenCalled()
  })

  it('deep-links a known OAuth provider row into its setup flow', async () => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'qwen-oauth', model: '' })
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Qwen',
          slug: 'qwen-oauth',
          models: [],
          authenticated: false,
          auth_type: 'oauth'
        }
      ]
    })

    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Set up Qwen' }))

    expect(startManualProviderOAuth).toHaveBeenCalledWith('qwen-oauth')
    expect(startManualLocalEndpoint).not.toHaveBeenCalled()
    expect(startManualOnboarding).not.toHaveBeenCalled()
  })

  it('replaces the selected provider and model when the active profile changes', async () => {
    getGlobalModelInfo
      .mockResolvedValueOnce({ provider: 'custom', model: 'local-a' })
      .mockResolvedValueOnce({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    getGlobalModelOptions
      .mockResolvedValueOnce({
        providers: [
          {
            name: 'Custom A',
            slug: 'custom',
            models: ['local-a'],
            authenticated: true
          }
        ]
      })
      .mockResolvedValueOnce({
        providers: [
          {
            name: 'DeepSeek',
            slug: 'deepseek',
            models: ['deepseek-v4-pro'],
            authenticated: true,
            capabilities: { 'deepseek-v4-pro': { reasoning: true, fast: true } }
          }
        ]
      })

    await renderModelSettings()
    expect((await screen.findAllByRole('combobox'))[0].textContent).toContain('Custom A')

    await act(async () => {
      profileSwitchHandler?.()
    })

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByRole('combobox')[0].textContent).toContain('DeepSeek'))
    expect(screen.queryByRole('button', { name: 'Set up provider' })).toBeNull()
  })

  it('preserves a user-defined provider endpoint when applying the main model', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Nous',
          slug: 'nous',
          models: ['hermes-4'],
          authenticated: true
        },
        {
          name: 'Ollama',
          slug: 'custom:local-ollama',
          models: ['qwen3:latest'],
          authenticated: true,
          is_user_defined: true,
          api_url: 'http://localhost:11434/v1'
        }
      ]
    })
    setModelAssignment.mockResolvedValueOnce({
      provider: 'custom:local-ollama',
      model: 'qwen3:latest',
      gateway_tools: []
    })

    await renderModelSettings()

    const providerSelect = (await screen.findAllByRole('combobox'))[0]
    fireEvent.click(providerSelect)
    fireEvent.click(await screen.findByRole('option', { name: 'Ollama' }))

    const modelSelect = (await screen.findAllByRole('combobox'))[1]
    fireEvent.click(modelSelect)
    fireEvent.click(await screen.findByRole('option', { name: 'qwen3:latest' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'qwen3:latest',
        provider: 'custom:local-ollama',
        scope: 'main',
        base_url: 'http://localhost:11434/v1'
      })
    )
  })

  it('writes the profile default speed (service_tier) when the fast switch is toggled', async () => {
    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    const fastSwitch = await screen.findByRole('switch')
    fireEvent.click(fastSwitch)

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agent: expect.objectContaining({ service_tier: 'fast' }) })
      )
    )
  })

  it('hides the reasoning/speed defaults when the main model reports no capabilities', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'DeepSeek',
          slug: 'deepseek',
          models: ['deepseek-v4-pro'],
          authenticated: true,
          capabilities: { 'deepseek-v4-pro': { reasoning: false, fast: false } }
        }
      ]
    })

    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders the auxiliary task rows', async () => {
    await renderModelSettings()

    expect(await screen.findByText('Vision')).toBeTruthy()
    expect(screen.getAllByText('auto · use main model').length).toBeGreaterThan(0)
  })

  it('assigns an auxiliary task to the main model via setModelAssignment', async () => {
    await renderModelSettings()

    // One "Set to main" button per task slot; the first is Vision.
    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        scope: 'auxiliary',
        task: 'vision'
      })
    )
  })

  it('carries the user-defined endpoint when an aux slot is set to a local main model', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Ollama',
          slug: 'custom:local-ollama',
          models: ['qwen3:latest'],
          authenticated: true,
          is_user_defined: true,
          api_url: 'http://localhost:11434/v1'
        }
      ]
    })
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'custom:local-ollama', model: 'qwen3:latest' })
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'custom:local-ollama', model: 'qwen3:latest' },
      tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
    })

    await renderModelSettings()

    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'qwen3:latest',
        provider: 'custom:local-ollama',
        scope: 'auxiliary',
        task: 'vision',
        base_url: 'http://localhost:11434/v1'
      })
    )
  })

  it('warns when a main switch leaves auxiliary tasks pinned to another provider', async () => {
    setModelAssignment.mockResolvedValueOnce({
      provider: 'zai',
      model: 'glm-5.2',
      gateway_tools: [],
      stale_aux: [{ task: 'compression', provider: 'deepseek', model: 'deepseek-v4-pro' }]
    })

    await renderModelSettings()
    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())

    const applyButton = await screen.findByRole('button', { name: 'Apply' })
    fireEvent.click(applyButton)

    // The switch-time notice names the pinned provider and offers a reset.
    expect(await screen.findByText(/still run on/)).toBeTruthy()
    expect(screen.getByText('deepseek')).toBeTruthy()
  })

  it('shows a persistent banner when a loaded aux slot mismatches the main provider', async () => {
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      tasks: [{ task: 'curator', provider: 'zai', model: 'glm-5.2', base_url: '' }]
    })

    await renderModelSettings()

    // Banner present on load, no switch required.
    expect(await screen.findByText(/still run on/)).toBeTruthy()
  })
})

// hc-578 / MOA-INVISIBLE-DESIGN: picking a second platform model composes a
// hidden `__auto__` Mixture-of-Agents preset. These guard the two halves of the
// contract — the wire calls it makes, and the words it must never say. They
// replace upstream's explicit preset/aggregator editor tests: that editor is
// held shut by SHOW_EXPLICIT_MOA_UI.
describe('ModelSettings platform multi-select (invisible MoA)', () => {
  const MANAGED = 'custom:apex-nodes.com'

  beforeEach(() => {
    // A tiny stateful backend: applying writes, and the page's post-apply
    // reload reads back what was written. Without the round-trip the reload
    // would silently revert the chips, hiding exactly the regression these
    // tests exist to catch.
    // Main model starts on a BYO provider, so no platform chip is preselected.
    let applied = { model: 'minimax-m2', provider: 'minimax' }
    let savedMoa: unknown = null

    getGlobalModelInfo.mockImplementation(() => Promise.resolve(applied))
    saveMoaModels.mockImplementation((body: unknown) => {
      savedMoa = body

      return Promise.resolve(body)
    })
    getMoaModels.mockImplementation(() => Promise.resolve(savedMoa))
    setModelAssignment.mockImplementation((body: { model: string; provider: string; scope: string }) => {
      if (body.scope === 'main') {
        applied = { model: body.model, provider: body.provider }
      }

      return Promise.resolve({ ...applied, gateway_tools: [], stale_aux: [] })
    })
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        {
          name: 'Apex-nodes.com',
          slug: MANAGED,
          is_user_defined: true,
          authenticated: true,
          models: ['deepseek-v4-pro-APEX', 'glm-5.2', 'qwen3.7-max']
        },
        // A domestic BYO provider (the user's own key) — survives the filter.
        { name: 'MiniMax', slug: 'minimax', authenticated: true, models: ['minimax-m2'] },
        // Foreign — the China-first filter must keep it out of every selector.
        { name: 'OpenAI', slug: 'openai-codex', authenticated: true, models: ['gpt-5.5'] }
      ]
    })
    getAuxiliaryModels.mockResolvedValue({
      main: { provider: 'minimax', model: 'minimax-m2' },
      tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
    })
  })

  it('renders a chip per platform model and hides foreign providers', async () => {
    await renderModelSettings()

    expect(await screen.findByRole('button', { name: 'DeepSeek V4 Pro' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GLM 5.2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Qwen3.7 Max' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /GPT/ })).toBeNull()
  })

  it('keeps the plain single-model path while only one model is picked', async () => {
    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({ model: 'glm-5.2', provider: MANAGED, scope: 'main' })
    )
    expect(saveMoaModels).not.toHaveBeenCalled()
  })

  it('composes a hidden user_turn preset once a second model is picked', async () => {
    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))

    await waitFor(() => expect(saveMoaModels).toHaveBeenCalled())

    const sent = saveMoaModels.mock.calls[0][0]
    // Qwen3.7 Max outranks GLM 5.2 on quality-per-cost, so it acts; GLM is the
    // reference. Every member must come from the user's own selection.
    expect(sent.presets.__auto__.aggregator).toEqual({ provider: MANAGED, model: 'qwen3.7-max' })
    expect(sent.presets.__auto__.reference_models).toEqual([{ provider: MANAGED, model: 'glm-5.2' }])
    // Per user turn, not per tool-loop iteration — that would multiply the bill
    // by the loop length instead of pinning it at N+1 (MOA-INVISIBLE-DESIGN §4).
    expect(sent.presets.__auto__.fanout).toBe('user_turn')

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({ model: '__auto__', provider: 'moa', scope: 'main' })
    )
  })

  it('never surfaces MoA / aggregator / reference / preset terminology', async () => {
    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))
    await waitFor(() => expect(saveMoaModels).toHaveBeenCalled())

    expect(screen.queryByText(/mixture of agents|aggregator|reference model|preset|__auto__|\bmoa\b/i)).toBeNull()
    // "N models selected" is the one thing the multi-select is allowed to say.
    expect(screen.getByText(/2 models selected/i)).toBeTruthy()
  })

  // This callout is the ONE roomy slot for the multi-select copy — a wrapping
  // box, not a truncating line — so it carries the long form that explains how
  // the selection is billed. The composer pill and the model menu are
  // single-line slots and use `selectedShort` instead; sharing the long
  // sentence with them is what truncated the pill to "已选 2 个模…". (Lives in
  // this describe because the chips it clicks come from the platform-provider
  // mocks above — hc-598's restructure once left it stranded without them.)
  it('uses the long form (with the billing explanation) in the settings callout', async () => {
    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))

    expect(await screen.findByText(/2 models selected · they answer together/i)).toBeTruthy()
    expect(screen.getByText(/billed to your ledger by its own actual usage/i)).toBeTruthy()
  })

  it('reconstructs the selection from a live composed preset on load', async () => {
    getGlobalModelInfo.mockResolvedValue({ provider: 'moa', model: '__auto__' })
    getMoaModels.mockResolvedValue({
      default_preset: '__auto__',
      active_preset: '__auto__',
      presets: {
        __auto__: {
          reference_models: [{ provider: MANAGED, model: 'glm-5.2' }],
          aggregator: { provider: MANAGED, model: 'qwen3.7-max' },
          reference_temperature: 0,
          aggregator_temperature: 0,
          max_tokens: 4096,
          enabled: true,
          fanout: 'user_turn'
        }
      },
      reference_models: [{ provider: MANAGED, model: 'glm-5.2' }],
      aggregator: { provider: MANAGED, model: 'qwen3.7-max' },
      reference_temperature: 0,
      aggregator_temperature: 0,
      max_tokens: 4096,
      enabled: true
    })

    await renderModelSettings()

    expect(await screen.findByRole('button', { name: 'GLM 5.2', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Qwen3.7 Max', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'DeepSeek V4 Pro', pressed: false })).toBeTruthy()
    // The composed selection must never leak into the single-model selectors as
    // the raw `moa` / `__auto__` pair.
    expect(screen.queryByText(/__auto__/)).toBeNull()
  })

})
