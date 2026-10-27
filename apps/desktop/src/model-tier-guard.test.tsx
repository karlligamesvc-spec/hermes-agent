/**
 * hc-960 guard: on an APEX account (tier mode) no surface names a model.
 *
 * Each test renders a real surface with model ids planted in its data — the
 * pre-tier `-APEX` seed, the old first-party shelf, the tier aliases the relay
 * routes — and scans the DOM text for any model vocabulary. The only names
 * allowed are the tiers themselves (Flash / Pro / Max). A twin assertion with
 * tier mode OFF proves each surface really carries the names it is hiding, so
 * a scan that finds nothing is not passing by accident.
 *
 * Injecting a model name into any of these surfaces turns this file red; the
 * PR body lists the injections that were run.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BusinessGoalLauncher } from '@/app/business-workspace/components/business-goal-launcher'
import { ModelPickerOverlay } from '@/app/model-picker-overlay'
import { ModelSection, ModelTierSettings } from '@/app/settings/model-tier-settings'
import { HiddenInModelTierMode } from '@/components/model-tier/hidden-in-tier-mode'
import { retryStrongerTier } from '@/components/model-tier/retry-stronger'
import { ModelTierPicker } from '@/components/model-tier/tier-picker'
import { isDesktopSlashSuggestion } from '@/lib/desktop-slash-commands'
import type { ModelTier } from '@/lib/model-tiers'
import { APEX_PUBLIC_LLM_MODELS, MANAGED_PROVIDER_SLUG } from '@/lib/provider-allowlist'
import { $authState } from '@/store/auth'
import { $freeTierStatus } from '@/store/free-tier'
import { $freeTierStatusForChrome, userFacingModelName, useUserFacingModelName } from '@/store/model-tiers'
import { $activeGatewayProfile } from '@/store/profile'
import { setGatewayState, setModelPickerOpen } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setMultiBotFlagForTest } from '@/store/single-thread-bots'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

/** Everything that would name a model: raw ids, the relay aliases (an id is an
 *  id), the brand sentinel, and the vendor / family words a pretty-printer
 *  produces from them. */
// No word boundaries: concatenated UI text ("…lineKimi K2.7") must still hit.
const MODEL_VOCABULARY = new RegExp(
  [
    ...APEX_PUBLIC_LLM_MODELS.map(model => model.replace(/[.]/g, '\\.')),
    'apex-(?:flash|pro|max)',
    '-APEX',
    'deepseek',
    'kimi',
    'gemini',
    'qwen',
    'glm',
    'mimo',
    'hy4',
    'claude',
    'sonnet',
    'gpt-',
    'nous portal'
  ].join('|'),
  'gi'
)

function modelNamesIn(text: string): string[] {
  return [...text.matchAll(MODEL_VOCABULARY)].map(match => match[0])
}

/** Every text node (hidden or not) plus the attributes a screen reader or a
 *  tooltip would surface — one space between each so nodes never fuse. */
function surfaceText(container: HTMLElement): string {
  const walker = globalThis.document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const parts: string[] = []

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? '')
  }

  for (const element of container.querySelectorAll('*')) {
    for (const name of ['title', 'aria-label', 'placeholder']) {
      parts.push(element.getAttribute(name) ?? '')
    }
  }

  return parts.join(' ')
}

function expectNoModelNames(container: HTMLElement) {
  expect(modelNamesIn(surfaceText(container))).toEqual([])
}

const hermes = vi.hoisted(() => ({
  getAuxiliaryModels: vi.fn(),
  getGlobalModelInfo: vi.fn(),
  getGlobalModelOptions: vi.fn(),
  getMoaModels: vi.fn(),
  setModelAssignment: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<object>()),
  getAuxiliaryModels: (profile?: null | string) => hermes.getAuxiliaryModels(profile),
  getGlobalModelInfo: (profile?: null | string) => hermes.getGlobalModelInfo(profile),
  getGlobalModelOptions: (opts?: unknown, profile?: null | string) => hermes.getGlobalModelOptions(opts, profile),
  getMoaModels: (profile?: null | string) => hermes.getMoaModels(profile),
  setModelAssignment: (body: unknown, profile?: null | string) => hermes.setModelAssignment(body, profile)
}))

vi.mock('@/app/hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: () => undefined }))

vi.mock('@/store/onboarding', async importOriginal => ({
  ...(await importOriginal<object>()),
  startManualLocalEndpoint: vi.fn(),
  startManualOnboarding: vi.fn(),
  startManualProviderOAuth: vi.fn()
}))

// The overlay's real dialog lists the whole catalog; stand in with one that
// prints model ids, so "rendered at all" is visible to the scan.
vi.mock('@/components/model-picker', () => ({
  ModelPickerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="model-picker-dialog">deepseek-v4-pro · kimi-k2.7-code</div> : null
}))

/** The relay's managed row lists the old shelf AND the tier aliases; the
 *  user also has their own DeepSeek key. */
const MANAGED_ROW = {
  authenticated: true,
  models: ['apex-flash', 'apex-pro', ...APEX_PUBLIC_LLM_MODELS, 'deepseek-flash-APEX'],
  name: 'Apex-nodes.com',
  slug: MANAGED_PROVIDER_SLUG
}

const OWN_ROW = { authenticated: true, models: ['deepseek-chat'], name: 'DeepSeek', slug: 'deepseek' }

function setTierMode(on: boolean) {
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: on,
    status: 'signed-in'
  })
}

function renderWithClients(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  hermes.getGlobalModelInfo.mockResolvedValue({ model: 'deepseek-flash-APEX', provider: 'custom' })
  hermes.getGlobalModelOptions.mockResolvedValue({ providers: [MANAGED_ROW, OWN_ROW] })
  hermes.getAuxiliaryModels.mockResolvedValue({ main: { model: 'deepseek-flash-APEX', provider: 'custom' }, tasks: [] })
  hermes.getMoaModels.mockResolvedValue(null)
  hermes.setModelAssignment.mockImplementation(async (body: { model: string; provider: string }) => body)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  setModelPickerOpen(false)
  setGatewayState('idle')
  setTierMode(false)
})

describe('Settings › 档位 — "这个助手用哪一档"', () => {
  it('shows three tiers and no model for an assistant still on the pre-tier seed', async () => {
    setTierMode(true)

    // ModelSection is what Settings mounts: the tier switch itself is under test.
    const view = renderWithClients(<ModelSection />)

    const flash = await screen.findByRole('radio', { name: /Flash/ })
    await waitFor(() => expect(flash.getAttribute('aria-checked')).toBe('true'))
    expect(screen.getAllByRole('radio').map(card => card.getAttribute('data-tier'))).toEqual(['flash', 'pro', 'max'])

    expectNoModelNames(view.container)
  })

  it('writes the tier alias on the managed relay, for this assistant only', async () => {
    setTierMode(true)
    renderWithClients(<ModelTierSettings scopeProfile="research" />)

    const pro = await screen.findByRole('radio', { name: /Pro/ })
    await waitFor(() => expect(pro.getAttribute('data-state')).toBe('available'))

    fireEvent.click(pro)

    await waitFor(() =>
      expect(hermes.setModelAssignment).toHaveBeenCalledWith(
        { model: 'apex-pro', provider: MANAGED_PROVIDER_SLUG, scope: 'main' },
        'research'
      )
    )
  })

  it('keeps the APEX shelf out of the 高级 fold, which holds only the user’s own service', async () => {
    setTierMode(true)

    const view = renderWithClients(<ModelTierSettings />)
    await screen.findByRole('radio', { name: /Flash/ })

    fireEvent.click(screen.getByRole('button', { name: /高级|Advanced/ }))
    // Only the BYOK fold asks for auxiliary slots — it has loaded once this lands.
    await waitFor(() => expect(hermes.getAuxiliaryModels).toHaveBeenCalled())
    await act(async () => undefined)

    // Open the fold's provider list: the user's own DeepSeek is offered (the
    // control — the list is really there), the APEX relay row is not.
    const providerSelect = (await screen.findAllByRole('combobox'))[0]
    fireEvent.pointerDown(providerSelect, { button: 0, ctrlKey: false, pointerType: 'mouse' })

    const options = (await screen.findAllByRole('option')).map(option => option.textContent ?? '')

    expect(options.join(' ')).toMatch(/DeepSeek/)
    expect(options.join(' ')).not.toMatch(/apex-nodes/i)

    // The user's own DeepSeek may be named here; the relay's models may not.
    const shelf = new RegExp(
      ['apex-(?:flash|pro|max)', '-APEX', ...APEX_PUBLIC_LLM_MODELS.filter(id => !id.startsWith('deepseek'))]
        .map(id => id.replace(/[.]/g, '\\.'))
        .join('|'),
      'i'
    )

    expect(surfaceText(globalThis.document.body)).not.toMatch(shelf)
    expect(view.container.querySelector('[data-testid="model-tier-settings"]')).toBeTruthy()
  })
})

describe('tier cards never borrow a model name', () => {
  it.each([
    ['free', { status: 'ready', tiers: new Set<ModelTier>(['flash']) }],
    ['fast', { status: 'ready', tiers: new Set<ModelTier>(['flash', 'pro']) }],
    ['relay not ready', { status: 'not-ready' }],
    ['unknown', { status: 'unknown' }]
  ] as const)('%s', (_label, availability) => {
    setTierMode(true)

    const view = renderWithClients(
      <ModelTierPicker availability={availability} onChange={() => undefined} showTitle value="flash" />
    )

    expectNoModelNames(view.container)
  })
})

describe('the Start input', () => {
  const model = { canSwitch: true, model: 'kimi-k2.7-code', provider: MANAGED_PROVIDER_SLUG }

  it('carries no model pill on an APEX account', () => {
    setTierMode(true)

    const view = renderWithClients(<BusinessGoalLauncher model={model} onSubmit={() => true} />)

    expectNoModelNames(view.container)
  })

  it('(control) does show the model without tier mode', () => {
    setTierMode(false)

    const view = renderWithClients(<BusinessGoalLauncher model={model} onSubmit={() => true} />)

    expect(modelNamesIn(surfaceText(view.container)).length).toBeGreaterThan(0)
  })
})

describe('the model picker overlay', () => {
  const overlay = (
    <ModelPickerOverlay onSelect={() => undefined} profile="default" requestGateway={async () => undefined as never} />
  )

  it('never opens on an APEX account, whatever asked for it', () => {
    setTierMode(true)
    setGatewayState('open')
    setModelPickerOpen(true)

    renderWithClients(overlay)

    expect(screen.queryByTestId('model-picker-dialog')).toBeNull()
  })

  it('(control) opens without tier mode', () => {
    setTierMode(false)
    setGatewayState('open')
    setModelPickerOpen(true)

    renderWithClients(overlay)

    expect(screen.getByTestId('model-picker-dialog')).toBeTruthy()
  })
})

describe('display-only surfaces (session cards, subagents, routines)', () => {
  it('turn every APEX id into a tier and the user’s own model into nothing', () => {
    setTierMode(true)

    for (const id of [...APEX_PUBLIC_LLM_MODELS, 'deepseek-flash-APEX', 'apex-flash', 'apex-pro', 'apex-max']) {
      expect(modelNamesIn(userFacingModelName(id))).toEqual([])
      expect(['Flash', 'Pro', 'Max']).toContain(userFacingModelName(id))
    }

    expect(userFacingModelName('deepseek-chat', 'deepseek')).toBe('')
  })

  it('… and so does the hook those components render with', () => {
    setTierMode(true)

    const { result } = renderHook(() => useUserFacingModelName())

    expect(result.current('deepseek-flash-APEX')).toBe('Flash')
    expect(result.current('apex-pro')).toBe('Pro')
    expect(result.current('deepseek-chat', 'deepseek')).toBe('')
  })

  it('(control) keep friendly model names without tier mode', () => {
    setTierMode(false)

    expect(userFacingModelName('kimi-k2.7-code')).toMatch(/kimi/i)
    expect(renderHook(() => useUserFacingModelName()).result.current('kimi-k2.7-code')).toMatch(/kimi/i)
  })
})

describe('the shared gates (cron, Kanban and toolset fields; free-tier chrome)', () => {
  const wrapped = (
    <HiddenInModelTierMode>
      <span>deepseek-v4-pro</span>
    </HiddenInModelTierMode>
  )

  it('drop a wrapped model control on an APEX account', () => {
    setTierMode(true)

    expectNoModelNames(render(wrapped).container)
  })

  it('(control) keep it without tier mode', () => {
    setTierMode(false)

    expect(render(wrapped).container.textContent).toBe('deepseek-v4-pro')
  })

  it('read the Nous free tier as absent wherever it is painted', () => {
    const status = {
      available: true,
      enabled: true,
      has_guest: true,
      label: 'Nous · free tier',
      model: 'hermes-free',
      notice_pending: true
    }

    $freeTierStatus.set(status)

    try {
      setTierMode(true)
      expect($freeTierStatusForChrome.get()).toBeNull()

      setTierMode(false)
      expect($freeTierStatusForChrome.get()).toEqual(status)
    } finally {
      $freeTierStatus.set(null)
    }
  })
})

describe('slash commands', () => {
  it('stop offering /model and /moa', () => {
    setTierMode(true)

    expect(isDesktopSlashSuggestion('/moa')).toBe(false)
    expect(isDesktopSlashSuggestion('/model')).toBe(false)
  })
})

describe('换更强的再答一次 offers only a tier the account can use', () => {
  const advanced = { status: 'ready', tiers: new Set<ModelTier>(['flash', 'pro', 'max']) } as const
  const free = { status: 'ready', tiers: new Set<ModelTier>(['flash']) } as const

  it.each([
    ['Flash → Pro', 'apex-flash', advanced, false, 'pro'],
    ['the pre-tier seed counts as Flash', 'deepseek-flash-APEX', advanced, false, 'pro'],
    ['Pro → Max once Max is open', 'apex-pro', advanced, true, 'max'],
    ['Pro stops while Max is closed', 'apex-pro', advanced, false, null],
    ['a free account is not offered a locked Pro', 'apex-flash', free, false, null],
    ['Max is the top', 'apex-max', advanced, true, null]
  ] as const)('%s', (_label, model, availability, maxOpen, expected) => {
    expect(retryStrongerTier(model, MANAGED_PROVIDER_SLUG, availability, maxOpen)).toBe(expected)
  })

  it('never offers a tier on the user’s own model', () => {
    expect(retryStrongerTier('deepseek-chat', 'deepseek', advanced, true)).toBeNull()
  })
})

describe('hc-1077 K3: with several assistants on, the tier is the account’s', () => {
  afterEach(() => {
    setMultiBotFlagForTest(false)
    setSingleThreadFlagForTest(false)
    $activeGatewayProfile.set('default')
  })

  it('on another assistant, Settings › 档位 reads and writes APEX’s (the root the others follow)', async () => {
    setTierMode(true)
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    $activeGatewayProfile.set('writer')
    renderWithClients(<ModelSection />)

    const pro = await screen.findByRole('radio', { name: /Pro/ })
    await waitFor(() => expect(pro.getAttribute('data-state')).toBe('available'))
    expect(hermes.getGlobalModelInfo).toHaveBeenCalledWith('default')
    expect(hermes.getGlobalModelInfo).not.toHaveBeenCalledWith('writer')

    fireEvent.click(pro)

    await waitFor(() =>
      expect(hermes.setModelAssignment).toHaveBeenCalledWith(
        { model: 'apex-pro', provider: MANAGED_PROVIDER_SLUG, scope: 'main' },
        'default'
      )
    )
  })

  it('the model page without tier mode too', async () => {
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    $activeGatewayProfile.set('writer')
    renderWithClients(<ModelSection />)

    await waitFor(() => expect(hermes.getGlobalModelInfo).toHaveBeenCalledWith('default'))
    expect(hermes.getGlobalModelInfo).not.toHaveBeenCalledWith(undefined)
  })

  it.each([
    ['on APEX itself', true, 'default'],
    ['with the switch off', false, 'writer']
  ])('(control) %s the page keeps following the active profile', async (_label, multiBot, active) => {
    setTierMode(true)
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(multiBot)
    $activeGatewayProfile.set(active)
    renderWithClients(<ModelSection />)

    await screen.findByRole('radio', { name: /Pro/ })
    expect(hermes.getGlobalModelInfo).toHaveBeenCalledWith(undefined)
  })
})
