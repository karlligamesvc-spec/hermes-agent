import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { ACCOUNT_KINDS, seedAccount } from './__identity__/settings-fold/harness'
import { voiceProviderRow } from './__identity__/settings-voice/render'

/**
 * hc-1193 identity guard (hard rule 11) for Settings › 语音's 「文字转语音提供方」
 * row: what it shows, what its list offers and which voice fields the page
 * mounts, for each saved `tts.provider`, in the three modes for the three
 * account kinds. Recorded on fork main 598bf3e896 with the same harness, before
 * hc-1193.
 *
 * GET /api/config fills keys the profile never saved with upstream defaults
 * (`tts.provider: edge`); `?include_defaults=false` is the saved layer.
 */

const config = vi.hoisted(() => ({ merged: {} as Record<string, unknown>, saved: {} as Record<string, unknown> }))

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getElevenLabsVoices: vi.fn(async () => ({ available: false, voices: [] })),
  getHermesConfigRecord: vi.fn(async (_profile?: unknown, options?: { includeDefaults?: boolean }) =>
    structuredClone(options?.includeDefaults === false ? config.saved : config.merged)
  ),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))
beforeAll(() => {
  // Radix Select scrolls its items into view and asks for pointer capture; jsdom has neither.
  Element.prototype.scrollIntoView ??= () => undefined
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
})

afterAll(() => {
  vi.restoreAllMocks()
})

const signedOut = $authState.get()

afterEach(() => {
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $authState.set(signedOut)
})

const VOICES = { edge: { voice: 'en-US-AriaNeural' }, openai: { voice: 'alloy' } }

/** The saved `tts.provider` and what GET /api/config answers for it. */
const STATES: Record<string, { merged: Record<string, unknown>; saved: Record<string, unknown> }> = {
  'nothing saved': { merged: { tts: { provider: 'edge', ...VOICES } }, saved: {} },
  'saved edge': { merged: { tts: { provider: 'edge', ...VOICES } }, saved: { tts: { provider: 'edge' } } },
  'saved openai': { merged: { tts: { provider: 'openai', ...VOICES } }, saved: { tts: { provider: 'openai' } } },
  'saved empty': { merged: { tts: { provider: '', ...VOICES } }, saved: { tts: { provider: '' } } },
  'saved doubao': { merged: { tts: { provider: 'doubao', ...VOICES } }, saved: { tts: { provider: 'doubao' } } }
}

const GOLDEN = './__identity__/settings-voice'

describe.each([
  ['switch-off', false, 'product'],
  ['developer', true, 'technical'],
  ['product', true, 'product']
] as const)('%s: Settings › 语音 › 文字转语音提供方', (mode, singleThread, toolView) => {
  it.each(ACCOUNT_KINDS)(
    '%s',
    async account => {
      seedAccount(account)
      // Tool view first: switch-on-then-developer would pass through product mode on the way.
      setToolViewMode(toolView)
      setSingleThreadFlagForTest(singleThread)

      const rows: Record<string, unknown> = {}

      for (const [state, records] of Object.entries(STATES)) {
        config.merged = records.merged
        config.saved = records.saved
        rows[state] = await voiceProviderRow()
      }

      await expect(JSON.stringify(rows, null, 2) + '\n').toMatchFileSnapshot(
        `${GOLDEN}/provider-${mode}-${account}.json`
      )
    },
    30_000
  )
})
