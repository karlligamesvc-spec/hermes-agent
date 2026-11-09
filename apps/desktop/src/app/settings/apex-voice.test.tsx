import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $authState } from '@/store/auth'
import { settleConfirm } from '@/store/confirm'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { savedVoiceChoice, withApexVoiceDefault } from './apex-voice'
import { ConfigSettings } from './config-settings'

import { SettingsView } from './index'

/**
 * hc-1193: Settings › 语音 picks APEX's own voice again and 恢复默认 keeps it.
 * The engine speaks APEX's voice while the saved `tts.provider` is missing or
 * empty (apex_overlay/doubao_tts.py `load_tts_config`); GET /api/config fills a
 * missing key with upstream's `edge`, and /api/config/defaults is upstream's
 * DEFAULT_CONFIG. The golden guard (settings-voice-provider-identity) pins what
 * the row shows in every mode; these pin what it saves.
 */

const config = vi.hoisted(() => ({
  merged: {} as Record<string, unknown>,
  saved: {} as Record<string, unknown> | Error
}))

const api = vi.hoisted(() => ({
  getHermesConfigDefaults: vi.fn(),
  saveHermesConfig: vi.fn(async (_config: unknown, _profile?: unknown) => ({ ok: true }))
}))

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getElevenLabsVoices: vi.fn(async () => ({ available: false, voices: [] })),
  getHermesConfigDefaults: api.getHermesConfigDefaults,
  getHermesConfigRecord: vi.fn(async (_profile?: unknown, options?: { includeDefaults?: boolean }) => {
    const answer = options?.includeDefaults === false ? config.saved : config.merged

    if (answer instanceof Error) {
      throw answer
    }

    return structuredClone(answer)
  }),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  saveHermesConfig: api.saveHermesConfig
}))

// The settings pages other than 语音 are markers: the reset lives in the rail.
vi.mock('./about-settings', () => ({ AboutSettings: () => <div>about-view</div> }))
vi.mock('./appearance-settings', () => ({ AppearanceSettings: () => <div>appearance-view</div> }))
vi.mock('./gateway-settings', () => ({ GatewaySettings: () => <div>gateway-view</div> }))
vi.mock('./keybind-settings', () => ({ KeybindSettings: () => <div>keybind-view</div> }))
vi.mock('./personalization-settings', () => ({ PersonalizationSettings: () => <div>personalization-view</div> }))
vi.mock('./sessions-settings', () => ({ SessionsSettings: () => <div>sessions-view</div> }))

beforeAll(() => {
  // Radix Select scrolls its items into view and asks for pointer capture; jsdom has neither.
  Element.prototype.scrollIntoView ??= () => undefined
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
})

const signedOut = $authState.get()

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $authState.set(signedOut)
  vi.clearAllMocks()
})

function productModeOnApexAccount() {
  $authState.set({
    ...$authState.get(),
    account: { email: 'creator@example.com', name: '' } as never,
    accountId: 'acct-1',
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: true,
    status: 'signed-in'
  })
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
}

function Providers({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings?tab=config:voice']}>
        <I18nProvider configClient={null} initialLocale="zh">
          {children}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function providerSelect(): Promise<HTMLElement> {
  render(
    <Providers>
      <ConfigSettings activeSectionId="voice" importInputRef={createRef<HTMLInputElement>()} />
    </Providers>
  )

  return waitFor(() => {
    const row = globalThis.document.getElementById('setting-field-tts.provider')
    const trigger = row?.querySelector<HTMLElement>('[role="combobox"]')

    if (!trigger) {
      throw new Error('no 文字转语音提供方 row yet')
    }

    return trigger
  })
}

async function choose(trigger: HTMLElement, name: string) {
  act(() => {
    fireEvent.click(trigger)
  })
  fireEvent.click(await screen.findByRole('option', { name }))
}

const VOICES = { edge: { voice: 'en-US-AriaNeural' }, openai: { voice: 'alloy' } }

describe('savedVoiceChoice: the saved tts.provider the engine speaks APEX’s voice for', () => {
  it.each([
    [undefined, ''],
    [null, ''],
    ['', ''],
    ['doubao', ''],
    ['Doubao', ''],
    [' doubao ', ''],
    ['edge', 'edge'],
    ['openai', 'openai'],
    ['my-command-tts', 'my-command-tts']
  ])('%j → %j', (saved, choice) => {
    expect(savedVoiceChoice(saved)).toBe(choice)
  })
})

describe('Settings › 语音 in product mode on an APEX account', () => {
  it('names APEX’s voice when nothing is saved, and writes Edge over a cleared value when it is chosen', async () => {
    productModeOnApexAccount()
    config.merged = { tts: { provider: 'edge', ...VOICES } }
    config.saved = {}

    const trigger = await providerSelect()
    expect(trigger.textContent).toBe('APEX 配音（默认）')
    // Edge's own fields belong to Edge: they are not on screen while APEX speaks.
    expect(globalThis.document.getElementById('setting-field-tts.edge.voice')).toBeNull()

    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await choose(trigger, 'Edge')
      await vi.advanceTimersByTimeAsync(700)
      await waitFor(() => expect(api.saveHermesConfig).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }

    // The backend drops `edge` (upstream's default) unless the file already has the key.
    expect(api.saveHermesConfig.mock.calls.map(call => call[0])).toEqual([
      { tts: { provider: '' } },
      { tts: { provider: 'edge' } }
    ])
  })

  it('goes back to APEX’s voice from a saved provider by clearing it', async () => {
    productModeOnApexAccount()
    config.merged = { tts: { provider: 'openai', ...VOICES } }
    config.saved = { tts: { provider: 'openai' } }

    const trigger = await providerSelect()
    expect(trigger.textContent).toBe('Openai')

    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await choose(trigger, 'APEX 配音（默认）')
      await vi.advanceTimersByTimeAsync(700)
      await waitFor(() => expect(api.saveHermesConfig).toHaveBeenCalledTimes(1))
    } finally {
      vi.useRealTimers()
    }

    expect(api.saveHermesConfig.mock.calls[0][0]).toEqual({ tts: { provider: '' } })
    expect(trigger.textContent).toBe('APEX 配音（默认）')
  })

  it('shows what GET /api/config says when the saved layer cannot be read', async () => {
    productModeOnApexAccount()
    config.merged = { tts: { provider: 'edge', ...VOICES } }
    config.saved = new Error('older engine')

    expect((await providerSelect()).textContent).toBe('Edge')
  })
})

describe('恢复默认', () => {
  it('saves upstream’s defaults with APEX’s voice instead of Edge', async () => {
    const defaults = {
      display: { personality: 'kawaii' },
      tts: { edge: { voice: 'en-US-AriaNeural' }, provider: 'edge' }
    }

    api.getHermesConfigDefaults.mockResolvedValue(defaults)
    config.merged = {}
    config.saved = {}

    render(
      <Providers>
        <SettingsView onClose={vi.fn()} />
      </Providers>
    )

    const reset = globalThis.document.querySelector('.tabler-icon-refresh')?.closest('button')
    expect(reset).toBeTruthy()
    fireEvent.click(reset!)
    act(() => settleConfirm(true))

    await waitFor(() => expect(api.saveHermesConfig).toHaveBeenCalledTimes(1))
    expect(api.saveHermesConfig.mock.calls[0][0]).toEqual({
      display: { personality: 'kawaii' },
      tts: { edge: { voice: 'en-US-AriaNeural' }, provider: '' }
    })
    expect(defaults.tts.provider).toBe('edge') // the defaults read is not edited in place
    expect(withApexVoiceDefault({})).toEqual({ tts: { provider: '' } })
  })
})
