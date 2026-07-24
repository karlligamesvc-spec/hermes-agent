import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { $modelPresets } from '@/store/model-presets'
import { $visibleModels } from '@/store/model-visibility'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'

import { ModelMenuPanel } from './model-menu-panel'

// Radix calls these on open; jsdom doesn't implement them (same shim used by
// model-edit-submenu.test.tsx / model-settings.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelOptions = vi.fn()
const getGlobalModelInfo = vi.fn()
const getMoaModels = vi.fn()
const saveMoaModels = vi.fn()
const setModelAssignment = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getGlobalModelOptions: (...args: unknown[]) => getGlobalModelOptions(...args),
  getMoaModels: () => getMoaModels(),
  saveMoaModels: (body: unknown) => saveMoaModels(body),
  setModelAssignment: (body: unknown) => setModelAssignment(body)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

const MANAGED = 'custom:apex-nodes.com'

beforeEach(() => {
  $activeSessionId.set(null)
  $currentModel.set('')
  $currentProvider.set('')
  $modelPresets.set({})
  $visibleModels.set(null)

  getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        name: 'Apex-nodes.com',
        slug: MANAGED,
        is_user_defined: true,
        authenticated: true,
        models: ['deepseek-v4-pro-APEX', 'glm-5.2', 'qwen3.7-max', 'kimi-k2.6']
      },
      // A domestic BYO provider — kept by the China-first filter, single-select.
      { name: 'MiniMax', slug: 'minimax', authenticated: true, models: ['minimax-m2'] }
    ]
  })
  getGlobalModelInfo.mockResolvedValue({ model: '', provider: '' })
  getMoaModels.mockResolvedValue(null)
  saveMoaModels.mockImplementation((body: unknown) => Promise.resolve({ ok: true, ...(body as object) }))
  setModelAssignment.mockResolvedValue({ ok: true, model: '__auto__', provider: 'moa' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(onSelectModel = vi.fn().mockResolvedValue(true)) {
  const queryClient = new QueryClient()
  const requestGateway = vi.fn().mockResolvedValue({})

  render(
    <QueryClientProvider client={queryClient}>
      <DropdownMenu open>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ModelMenuPanel onSelectModel={onSelectModel} requestGateway={requestGateway} />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>
  )

  return { onSelectModel, requestGateway }
}

// The full model list lives one level deep, behind the "current model" row
// (Codex-style top-level: reasoning + model + speed). Open it before every
// interaction/assertion that needs a family row.
async function openModelList() {
  const trigger = await screen.findByText('No models found')
  fireEvent.click(trigger)
  await screen.findByRole('button', { name: 'Search models' }).catch(() => null)
}

describe('ModelMenuPanel', () => {
  it('renders platform models as checkable rows and BYO as a plain row', async () => {
    renderPanel()
    await openModelList()

    expect(await screen.findByRole('menuitemcheckbox', { name: /DeepSeek V4 Pro/ })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: /GLM 5.2/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Minimax M2/ })).toBeTruthy()
  })

  it('never surfaces any MoA / aggregator / preset / reference terminology', async () => {
    renderPanel()
    await openModelList()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))

    await waitFor(() => expect(saveMoaModels).toHaveBeenCalled())

    expect(screen.queryByText(/mixture of agents|aggregator|reference model|preset|__auto__|\bmoa\b/i)).toBeNull()
    // The "N models selected" status line does appear (that's the one thing
    // multi-select IS allowed to say) — both in the top "current model" row
    // and the status line under the list.
    expect(screen.getAllByText(/2 models selected/i).length).toBeGreaterThan(0)
  })

  it('selecting exactly one platform model keeps the plain single-select path (no MoA call)', async () => {
    const { onSelectModel } = renderPanel()
    await openModelList()

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /GLM 5.2/ }))

    await waitFor(() => expect(onSelectModel).toHaveBeenCalledWith({ model: 'glm-5.2', provider: MANAGED }))
    expect(saveMoaModels).not.toHaveBeenCalled()
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('composes a hidden user_turn MoA once a second platform model is checked', async () => {
    renderPanel()
    await openModelList()

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))

    // qwen3.7-max ranks highest → aggregator; glm-5.2 is the sole reference;
    // fanout pinned to user_turn (billing red line) — same assembly as
    // Settings → Model (model-settings.tsx / moa-compose.ts).
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
    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({ model: '__auto__', provider: 'moa', scope: 'main' })
    )
  })

  it('grays out BYO rows once 2+ platform models are selected, with an explanation', async () => {
    renderPanel()
    await openModelList()

    const byo = (await screen.findByRole('menuitem', { name: /Minimax M2/ })) as HTMLElement
    expect(byo.getAttribute('aria-disabled')).not.toBe('true')

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))

    await waitFor(() =>
      expect((screen.getByRole('menuitem', { name: /Minimax M2/ }) as HTMLElement).getAttribute('aria-disabled')).toBe(
        'true'
      )
    )
    expect(screen.getByText(/can't be combined with platform models/i)).toBeTruthy()
  })

  it('deselecting back down to one model returns to the plain single-select path', async () => {
    const { onSelectModel } = renderPanel()
    await openModelList()

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))
    await waitFor(() => expect(saveMoaModels).toHaveBeenCalled())

    onSelectModel.mockClear()

    // Uncheck qwen — glm-5.2 alone remains, so this must fall back to the
    // composer's ordinary single-model switch (never a second MoA save).
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))

    await waitFor(() => expect(onSelectModel).toHaveBeenCalledWith({ model: 'glm-5.2', provider: MANAGED }))
    expect(saveMoaModels).toHaveBeenCalledTimes(1)
  })

  // Kael, v0.16.17 real-device: after checking the 2nd model the list showed
  // only ONE model, so a 3rd could never be picked. The catalog collapse came
  // from the backend (composing pins the main provider to the virtual `moa`,
  // which strands the relay row without its live-catalog probe — see
  // apex_overlay/moa_picker_probe.py), but the picker must hold its own end of
  // the contract too: rendering the list is driven by the provider payload and
  // the selection set, NEVER by reverse-lookup of the active model. `__auto__`
  // has no family row of its own, so any such lookup would empty the list.
  it('keeps every platform model listed while a composed selection is active', async () => {
    renderPanel()
    await openModelList()

    const platformRows = () =>
      screen.getAllByRole('menuitemcheckbox').map(row => row.textContent?.replace(/\s+/g, ' ').trim())

    expect(platformRows()).toEqual(['DeepSeek V4 Pro APEX', 'GLM 5.2', 'Qwen3.7 Max', 'Kimi K2.6'])

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))
    await waitFor(() => expect(setModelAssignment).toHaveBeenCalled())

    // Same four rows, same order — the active model is now the virtual
    // `__auto__`/`moa` pair, and that must not remove a single row.
    await waitFor(() =>
      expect(platformRows()).toEqual(['DeepSeek V4 Pro APEX', 'GLM 5.2', 'Qwen3.7 Max', 'Kimi K2.6'])
    )

    const checked = Object.fromEntries(
      screen
        .getAllByRole('menuitemcheckbox')
        .map(row => [row.textContent?.replace(/\s+/g, ' ').trim(), row.getAttribute('aria-checked')])
    )

    expect(checked).toEqual({
      'DeepSeek V4 Pro APEX': 'false',
      'GLM 5.2': 'true',
      'Qwen3.7 Max': 'true',
      'Kimi K2.6': 'false'
    })
  })

  it('can grow a composed selection from 2 to 3 models', async () => {
    renderPanel()
    await openModelList()

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))
    await waitFor(() => expect(saveMoaModels).toHaveBeenCalledTimes(1))

    // The third click is the one Kael could not make — the row had vanished.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Kimi K2.6/ }))

    await waitFor(() =>
      expect(saveMoaModels).toHaveBeenLastCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            __auto__: expect.objectContaining({
              // qwen3.7-max still outranks the newcomer, so the acting model is
              // unchanged and kimi joins the advisors.
              aggregator: { provider: MANAGED, model: 'qwen3.7-max' },
              reference_models: [
                { provider: MANAGED, model: 'glm-5.2' },
                { provider: MANAGED, model: 'kimi-k2.6' }
              ]
            })
          })
        })
      )
    )
    expect(await screen.findAllByText(/3 models selected/i)).toBeTruthy()
  })

  it('never rewrites the user-maintained visible-model set', async () => {
    renderPanel()
    await openModelList()

    // "Edit models…" is the ONLY writer of this store. A multi-select must not
    // narrow it as a side effect (that would shrink the list permanently, and
    // for every provider, not just while a selection is composed).
    expect($visibleModels.get()).toBeNull()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))
    await waitFor(() => expect(setModelAssignment).toHaveBeenCalled())

    expect($visibleModels.get()).toBeNull()
  })

  // The menu's two composed-selection slots are single truncating lines (the
  // "current model" sub-trigger and the status line under the list), so both
  // take the short copy. The long sentence lives in Settings › Model.
  it('uses the short copy in both composed-selection slots', async () => {
    renderPanel()
    await openModelList()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /GLM 5.2/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Qwen3.7 Max/ }))
    await waitFor(() => expect(setModelAssignment).toHaveBeenCalled())

    const slots = await screen.findAllByText(/2 models selected/i)
    expect(slots.length).toBe(2)
    slots.forEach(slot => expect(slot.textContent).toBe('2 models selected'))
    expect(screen.queryByText(/answer together|ledger|actual usage/i)).toBeNull()
  })
})
