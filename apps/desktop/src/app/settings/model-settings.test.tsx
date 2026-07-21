import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const saveMoaModels = vi.fn()
const setModelAssignment = vi.fn()
const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getGlobalModelOptions: () => getGlobalModelOptions(),
  getAuxiliaryModels: () => getAuxiliaryModels(),
  getMoaModels: () => getMoaModels(),
  saveMoaModels: (body: unknown) => saveMoaModels(body),
  setModelAssignment: (body: unknown) => setModelAssignment(body),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  saveHermesConfig: (config: unknown) => saveHermesConfig(config)
}))

vi.mock('@/store/notifications', () => ({
  notifyError: vi.fn()
}))

const MANAGED = 'custom:apex-nodes.com'

beforeEach(() => {
  // Main model is a hidden/foreign provider so the picker starts with an empty
  // selection (clean slate for the toggle tests).
  getGlobalModelInfo.mockResolvedValue({ provider: 'nous', model: 'hermes-4' })
  getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        name: 'Apex-nodes.com',
        slug: MANAGED,
        is_user_defined: true,
        authenticated: true,
        models: ['deepseek-v4-pro-APEX', 'glm-5.2', 'qwen3.7-max', 'kimi-k2.6'],
        capabilities: { 'deepseek-v4-pro-APEX': { reasoning: true, fast: true } }
      },
      // A domestic BYO provider (the user's own key) — kept by the China-first filter.
      { name: 'MiniMax', slug: 'minimax', authenticated: true, models: ['minimax-m2'] },
      // A foreign provider — the China-first filter must hide it from the chips.
      { name: 'OpenAI', slug: 'openai-codex', authenticated: true, models: ['gpt-5.5'] }
    ]
  })
  getAuxiliaryModels.mockResolvedValue({
    main: { provider: 'nous', model: 'hermes-4' },
    tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
  })
  getMoaModels.mockResolvedValue(null)
  saveMoaModels.mockImplementation((body: unknown) => Promise.resolve({ ok: true, ...(body as object) }))
  setModelAssignment.mockResolvedValue({ provider: '', model: '', gateway_tools: [], stale_aux: [] })
  getHermesConfigRecord.mockResolvedValue({ agent: { reasoning_effort: 'medium', service_tier: 'normal' } })
  saveHermesConfig.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderModelSettings() {
  const { ModelSettings } = await import('./model-settings')

  return render(<ModelSettings />)
}

describe('ModelSettings', () => {
  it('renders platform model chips and hides foreign providers', async () => {
    await renderModelSettings()

    expect(await screen.findByRole('button', { name: 'DeepSeek V4 Pro' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GLM 5.2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Qwen3.7 Max' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Kimi K2.6' })).toBeTruthy()
    // BYO (domestic own-key) is shown; the foreign provider is filtered out.
    expect(screen.getByRole('button', { name: 'Minimax M2' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /GPT/ })).toBeNull()
  })

  it('never surfaces any MoA / aggregator / preset terminology', async () => {
    await renderModelSettings()
    await screen.findByRole('button', { name: 'GLM 5.2' })

    // Select two platform models so the status line appears too.
    fireEvent.click(screen.getByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))
    await waitFor(() => expect(saveMoaModels).toHaveBeenCalled())

    expect(screen.queryByText(/mixture of agents|aggregator|reference model|preset|__auto__/i)).toBeNull()
  })

  it('applies a single platform model through the plain main-model path (no MoA)', async () => {
    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({ model: 'glm-5.2', provider: MANAGED, scope: 'main' })
    )
    expect(saveMoaModels).not.toHaveBeenCalled()
  })

  it('applies a single BYO model through the plain main-model path', async () => {
    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Minimax M2' }))

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({ model: 'minimax-m2', provider: 'minimax', scope: 'main' })
    )
    expect(saveMoaModels).not.toHaveBeenCalled()
  })

  it('composes a hidden user_turn MoA when a second platform model is picked', async () => {
    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))

    // qwen3.7-max ranks highest → aggregator; glm-5.2 is the sole reference;
    // fanout is pinned to user_turn (billing red line).
    await waitFor(() =>
      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          default_preset: '__auto__',
          active_preset: '__auto__',
          presets: expect.objectContaining({
            __auto__: expect.objectContaining({
              fanout: 'user_turn',
              aggregator: { provider: MANAGED, model: 'qwen3.7-max' },
              reference_models: [{ provider: MANAGED, model: 'glm-5.2' }]
            })
          })
        })
      )
    )
    // Activation switches the main slot onto the virtual moa provider.
    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({ model: '__auto__', provider: 'moa', scope: 'main' })
    )
  })

  it('normalizes the managed -APEX default to its routed id in MoA slots', async () => {
    await renderModelSettings()
    // deepseek-v4-pro-APEX + kimi-k2.6 → deepseek (rank 1) aggregates over kimi (rank 2).
    fireEvent.click(await screen.findByRole('button', { name: 'DeepSeek V4 Pro' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kimi K2.6' }))

    await waitFor(() =>
      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            __auto__: expect.objectContaining({
              aggregator: { provider: MANAGED, model: 'deepseek-v4-pro' },
              reference_models: [{ provider: MANAGED, model: 'kimi-k2.6' }]
            })
          })
        })
      )
    )
  })

  it('grays out BYO models while 2+ platform models are selected', async () => {
    await renderModelSettings()
    const byo = (await screen.findByRole('button', { name: 'Minimax M2' })) as HTMLButtonElement
    expect(byo.disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Minimax M2' }) as HTMLButtonElement).disabled).toBe(true)
    )
    expect(screen.getByText(/can't be combined with platform models/i)).toBeTruthy()
  })

  it('shows the multi-model status summary once 2+ are selected', async () => {
    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'GLM 5.2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Qwen3.7 Max' }))

    expect(await screen.findByText(/2 models selected/i)).toBeTruthy()
  })

  it('writes the profile default speed (service_tier) when the fast switch is toggled', async () => {
    // A managed main model with fast capability so the speed switch renders.
    getGlobalModelInfo.mockResolvedValueOnce({ provider: MANAGED, model: 'deepseek-v4-pro-APEX' })

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

  it('renders the auxiliary task rows', async () => {
    await renderModelSettings()

    expect(await screen.findByText('Vision')).toBeTruthy()
    expect(screen.getAllByText('auto · use main model').length).toBeGreaterThan(0)
  })

  it('assigns an auxiliary task to the main model via setModelAssignment', async () => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider: MANAGED, model: 'deepseek-v4-pro-APEX' })
    await renderModelSettings()

    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'deepseek-v4-pro-APEX',
        provider: MANAGED,
        scope: 'auxiliary',
        task: 'vision'
      })
    )
  })

  it('reconstructs the selection from an active __auto__ MoA preset on load', async () => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'moa', model: '__auto__' })
    getMoaModels.mockResolvedValueOnce({
      default_preset: '__auto__',
      active_preset: '__auto__',
      presets: {
        __auto__: {
          reference_models: [{ provider: MANAGED, model: 'glm-5.2' }],
          aggregator: { provider: MANAGED, model: 'qwen3.7-max' },
          fanout: 'user_turn',
          enabled: true
        }
      }
    })

    await renderModelSettings()

    // Both members show selected (aria-pressed), and the summary reflects 2.
    const glm = await screen.findByRole('button', { name: 'GLM 5.2' })
    const qwen = screen.getByRole('button', { name: 'Qwen3.7 Max' })
    expect(glm.getAttribute('aria-pressed')).toBe('true')
    expect(qwen.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/2 models selected/i)).toBeTruthy()
  })
})
