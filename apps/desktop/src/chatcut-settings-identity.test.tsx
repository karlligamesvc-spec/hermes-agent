import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsView } from '@/app/settings'
import { $authState } from '@/store/auth'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { ACCOUNT_KINDS, renderSettings, seedAccount } from './__identity__/settings-fold/harness'

/**
 * hc-1122 identity guard (hard rule 11) for the Settings overlay with the
 * ChatCut switch off: the rail, and where a `?tab=chatcut` link lands.
 *
 * The goldens under `__identity__/chatcut/` were recorded on fork main
 * c16f890339 with this file, before any ChatCut code existed. There the tab was
 * unknown, so it landed on the default page; with the switch off it still must.
 */

vi.mock('@/app/settings/about-settings', () => ({ AboutSettings: () => <div>about-view</div> }))
vi.mock('@/app/settings/appearance-settings', () => ({ AppearanceSettings: () => <div>appearance-view</div> }))
vi.mock('@/app/settings/config-settings', () => ({
  ConfigSettings: ({ activeSectionId }: { activeSectionId: string }) => <div>config-{activeSectionId}</div>
}))
vi.mock('@/app/settings/gateway-settings', () => ({ GatewaySettings: () => <div>gateway-view</div> }))
vi.mock('@/app/settings/keybind-settings', () => ({ KeybindSettings: () => <div>keybind-view</div> }))
vi.mock('@/app/settings/keys-settings', () => ({
  KEYS_VIEWS: ['tools', 'settings'],
  KeysSettings: ({ view }: { view: string }) => <div>keys-view-{view}</div>
}))
vi.mock('@/app/settings/notifications-settings', () => ({ NotificationsSettings: () => <div>notifications-view</div> }))
vi.mock('@/app/settings/personalization-settings', () => ({
  PersonalizationSettings: () => <div>personalization-view</div>
}))
vi.mock('@/app/settings/providers-settings', () => ({
  PROVIDER_VIEWS: ['accounts', 'keys', 'custom-endpoints', 'local'],
  ProvidersSettings: ({ view }: { view: string }) => <div>providers-view-{view}</div>
}))
vi.mock('@/app/settings/sessions-settings', () => ({ SessionsSettings: () => <div>sessions-view</div> }))
vi.mock('@/app/settings/vault-settings', () => ({
  vaultOwnerKey: () => 'vault-owner',
  VaultSettings: () => <div>vault-view</div>
}))

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
] as const)('%s: Settings with ChatCut off', (mode, singleThread, toolView) => {
  it.each(ACCOUNT_KINDS)('%s: the rail, and a link to the ChatCut tab', async account => {
    seedAccount(account)
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)

    const opened = await renderSettings(<SettingsView onClose={() => undefined} />, '/settings')
    const linked = await renderSettings(<SettingsView onClose={() => undefined} />, '/settings?tab=chatcut')

    await expect(
      `${JSON.stringify({ linked: { page: linked.page, rail: linked.rail }, rail: opened.rail }, null, 2)}\n`
    ).toMatchFileSnapshot(`./__identity__/chatcut/settings-${mode}-${account}.json`)
  })
})
