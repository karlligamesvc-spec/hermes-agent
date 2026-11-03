import { afterEach, describe, expect, it, vi } from 'vitest'

import { PersonalizationSettings } from '@/app/settings/personalization-settings'
import { $authState } from '@/store/auth'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { ACCOUNT_KINDS, pageHtml, seedAccount } from './__identity__/settings-fold/harness'

/**
 * hc-1109 identity guard (hard rule 11) for Settings › 个性化, the page every
 * mode opens on. Recorded on fork main 91b2f71eaf with the same harness, before
 * hc-1109 moved anything off it, in the three modes for the three account kinds.
 * The 记得什么 ledger is the real component (it shows only in product mode);
 * the parts that read the disk or the network are markers.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getHermesConfigRecord: vi.fn(async () => ({ display: { personality: 'concise' } }))
}))
vi.mock('@/app/settings/about-settings', () => ({ AboutSettingsBody: () => <div>about-body</div> }))
vi.mock('@/app/settings/creator-profile-settings', () => ({ CreatorProfileSettings: () => <div>creator-profile</div> }))
vi.mock('@/app/settings/soul-editor', () => ({
  SoulEditor: ({ profileName }: { profileName: string }) => <div>soul-editor-{profileName}</div>
}))

const GOLDEN = './__identity__/settings-fold'
const signedOut = $authState.get()

afterEach(() => {
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $authState.set(signedOut)
})

describe.each([
  ['switch-off', false, 'product'],
  ['developer', true, 'technical'],
  ['product', true, 'product']
] as const)('%s: Settings › 个性化', (mode, singleThread, toolView) => {
  it.each(ACCOUNT_KINDS)('%s', async account => {
    seedAccount(account)
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)

    await expect(await pageHtml(<PersonalizationSettings />)).toMatchFileSnapshot(
      `${GOLDEN}/personalization-${mode}-${account}.html`
    )
  })
})

describe('hc-1109: what 个性化 holds', () => {
  it.each([
    ['switch-off', true],
    ['developer', true],
    ['product', false]
  ] as const)('%s: 关于 at the foot → %s; the 记得什么 ledger lives under 记忆', async (mode, about) => {
    seedAccount('tier')
    setToolViewMode(mode === 'developer' ? 'technical' : 'product')
    setSingleThreadFlagForTest(mode !== 'switch-off')

    const html = await pageHtml(<PersonalizationSettings />)

    expect(html.includes('about-body')).toBe(about)
    expect(html).not.toContain('data-memory-ledger-settings')
    expect(html).toContain('creator-profile')
    expect(html).toContain('soul-editor-')
  })
})
