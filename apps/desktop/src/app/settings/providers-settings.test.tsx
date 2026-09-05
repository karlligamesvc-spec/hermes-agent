import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@/components/confirm-host'
import { $confirmRequest } from '@/store/confirm'
import type { EnvVarInfo, OAuthProvider } from '@/types/hermes'

const listOAuthProviders = vi.fn()
const disconnectOAuthProvider = vi.fn()
const getEnvVars = vi.fn()
const startManualProviderOAuth = vi.fn()
const startManualLocalEndpoint = vi.fn()
const onboarding = atom({ manual: false })

vi.mock('@/hermes', () => ({
  disconnectOAuthProvider: (providerId: string) => disconnectOAuthProvider(providerId),
  getEnvVars: () => getEnvVars(),
  listOAuthProviders: () => listOAuthProviders()
}))

vi.mock('@/store/onboarding', () => ({
  $desktopOnboarding: onboarding,
  startManualProviderOAuth: (providerId: string) => startManualProviderOAuth(providerId),
  startManualLocalEndpoint: (reason: null | string) => startManualLocalEndpoint(reason)
}))

function provider(id: string, loggedIn: boolean, patch: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    cli_command: `hermes auth add ${id}`,
    disconnectable: true,
    docs_url: '',
    flow: 'device_code',
    id,
    name: id === 'minimax-oauth' ? 'MiniMax' : id,
    status: {
      logged_in: loggedIn
    },
    ...patch
  }
}

// One `/api/env` row (an EnvVarInfo) for the API-keys view. Mirrors the
// `provider()` factory above: a valid base + per-test overrides, typed against
// the real response shape so it can't drift from EnvVarInfo.
function keyVar(patch: Partial<EnvVarInfo> = {}): EnvVarInfo {
  return {
    advanced: false,
    category: 'provider',
    description: '',
    is_password: true,
    is_set: false,
    provider: '',
    provider_label: '',
    redacted_value: null,
    tools: [],
    url: '',
    ...patch
  }
}

beforeEach(() => {
  onboarding.set({ manual: false })
  getEnvVars.mockResolvedValue({})
  disconnectOAuthProvider.mockResolvedValue({ ok: true, provider: 'minimax-oauth' })
  listOAuthProviders.mockResolvedValue({
    providers: [provider('minimax-oauth', true), provider('qwen-oauth', false)]
  })
})

afterEach(() => {
  cleanup()
  $confirmRequest.set(null)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// The accounts view hosts the ApexNodes connection cards; the IM-entry one
// navigates to /im-entry, so this view needs a router in scope. The cards
// themselves render nothing here (no window.hermesDesktop bridge in jsdom).
async function renderProvidersSettings() {
  const { ProvidersSettings } = await import('./providers-settings')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter>
        <ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="accounts" />
        <ConfirmHost />
      </MemoryRouter>
    )
  })

  return result!
}

describe('ProvidersSettings', () => {
  it('disconnects a connected provider account and refreshes the accounts list', async () => {
    await renderProvidersSettings()

    const remove = await screen.findByRole('button', { name: 'Remove MiniMax' })
    await act(async () => {
      fireEvent.click(remove)
    })

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(disconnectOAuthProvider).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    })

    await waitFor(() => expect(disconnectOAuthProvider).toHaveBeenCalledWith('minimax-oauth'))
    expect(listOAuthProviders).toHaveBeenCalledTimes(2)
  })

  it('leaves the account connected when the removal prompt is dismissed', async () => {
    await renderProvidersSettings()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove MiniMax' }))
    })

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    })

    expect(disconnectOAuthProvider).not.toHaveBeenCalled()
  })

  it('keeps provider selection separate from account removal', async () => {
    await renderProvidersSettings()

    await act(async () => {
      fireEvent.click(await screen.findByText('MiniMax'))
    })

    expect(startManualProviderOAuth).toHaveBeenCalledWith('minimax-oauth')
    expect(disconnectOAuthProvider).not.toHaveBeenCalled()
  })

  it('hides foreign provider accounts from the China-first accounts list', async () => {
    // Consumer build: only domestic sign-ins render. Nous / Anthropic /
    // OpenAI-style accounts disappear even when the backend reports them.
    listOAuthProviders.mockResolvedValue({
      providers: [provider('nous', true), provider('anthropic', false), provider('minimax-oauth', true)]
    })

    await renderProvidersSettings()

    expect(await screen.findByText('MiniMax')).toBeTruthy()
    expect(screen.queryByText('nous')).toBeNull()
    expect(screen.queryByText(/anthropic/)).toBeNull()
  })

  it('does not offer removal for externally managed providers', async () => {
    listOAuthProviders.mockResolvedValue({
      providers: [
        provider('qwen-oauth', true, {
          cli_command: 'hermes auth add qwen-oauth',
          disconnect_hint: "Use `hermes auth add qwen-oauth` or that provider's CLI to remove it.",
          disconnectable: false,
          flow: 'external',
          name: 'Qwen (via Qwen CLI)'
        })
      ]
    })

    await renderProvidersSettings()

    expect(await screen.findByText('Qwen Code')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Qwen Code' })).toBeNull()
    expect(screen.getByText(/managed by its own CLI/)).toBeTruthy()
  })

  it('renders a Keys card for a domestic backend-tagged provider with no PROVIDER_GROUPS prefix', async () => {
    // A provider the backend catalog tags (provider/provider_label) but that has
    // no desktop PROVIDER_GROUPS prefix row must still render its own card —
    // this is the GUI/CLI drift fix: membership comes from the backend, not
    // from the hand-maintained prefix list. `tencent-tokenhub` is in
    // DOMESTIC_PROVIDER_SLUGS, so it survives the China-first filter too.
    getEnvVars.mockResolvedValue({
      TENCENT_TOKENHUB_API_KEY: keyVar({
        provider: 'tencent-tokenhub',
        provider_label: 'Tencent TokenHub',
        url: 'https://tokenhub.example/keys'
      })
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)
    })

    expect(await screen.findByText('Tencent TokenHub')).toBeTruthy()
  })

  it('hides foreign provider key cards from the China-first Keys view', async () => {
    // Foreign vendors (prefix-grouped like Anthropic) and unknown
    // backend-tagged providers never render a card, keys set or not; the
    // domestic card still does.
    getEnvVars.mockResolvedValue({
      ANTHROPIC_API_KEY: keyVar({ is_set: true }),
      WIDGETAI_API_KEY: keyVar({ provider: 'widgetai', provider_label: 'WidgetAI' }),
      DEEPSEEK_API_KEY: keyVar()
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    expect(await screen.findByText('DeepSeek')).toBeTruthy()
    expect(screen.queryByText('Anthropic')).toBeNull()
    expect(screen.queryByText('WidgetAI')).toBeNull()
  })

  it('orders API-key providers by priority then name, and filters them via search', async () => {
    // These three domestic backend-tagged providers have no curated
    // PROVIDER_GROUPS priority, so they share the default priority and fall
    // back to alphabetical among themselves (Acme, Middle, Zebra) — exercising
    // the name tiebreak of the priority sort.
    getEnvVars.mockResolvedValue({
      ZEBRA_API_KEY: keyVar({ provider: 'zai', provider_label: 'Zebra' }),
      ACME_API_KEY: keyVar({ provider: 'deepseek', provider_label: 'Acme' }),
      MIDDLE_API_KEY: keyVar({ provider: 'stepfun', provider_label: 'Middle' })
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    // Equal priority → alphabetical tiebreak: Acme, Middle, Zebra.
    await screen.findByText('Acme')
    const labels = screen.getAllByText(/Acme|Middle|Zebra/).map(el => el.textContent)
    expect(labels).toEqual(['Acme', 'Middle', 'Zebra'])

    // Typing narrows the list to matching providers only.
    const search = screen.getByPlaceholderText('Search providers…')
    await act(async () => {
      fireEvent.change(search, { target: { value: 'mid' } })
    })

    await waitFor(() => expect(screen.queryByText('Acme')).toBeNull())
    expect(screen.getByText('Middle')).toBeTruthy()
    expect(screen.queryByText('Zebra')).toBeNull()

    // A non-matching query shows the empty-state copy.
    await act(async () => {
      fireEvent.change(search, { target: { value: 'nonesuch-xyz' } })
    })
    expect(await screen.findByText('No providers match your search.')).toBeTruthy()
  })

  it('offers a Local / custom endpoint entry in the API-keys tab that opens the custom-endpoint flow', async () => {
    // Regression: the composer pill and the providers "have an API key"
    // affordance both dead-end on the env-var-driven key catalog, which never
    // lists a custom endpoint — so without this row there is no reachable
    // Desktop GUI path to add one. See issue #62817.
    getEnvVars.mockResolvedValue({})
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    const row = await screen.findByText('Local / custom endpoint')
    expect(screen.getByText(/OpenAI-compatible endpoint/)).toBeTruthy()

    fireEvent.click(row)

    await waitFor(() => expect(startManualLocalEndpoint).toHaveBeenCalledWith(null))
  })
})
