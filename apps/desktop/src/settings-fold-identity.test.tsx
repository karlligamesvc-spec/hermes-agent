import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsView } from '@/app/settings'
import { $authState } from '@/store/auth'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { ACCOUNT_KINDS, renderSettings, seedAccount } from './__identity__/settings-fold/harness'

/**
 * hc-1109 identity guard (hard rule 11) for the Settings overlay: its rail, its
 * footer and which page each `?tab=` lands on.
 *
 * The goldens under `__identity__/settings-fold/` were recorded on fork main
 * 91b2f71eaf with the same harness, before hc-1109 folded any section: with
 * single_thread off, in developer mode and in product mode, for an APEX account
 * in tier mode, one without tiers, and the user's own key. The pages are
 * one-line markers here; the 个性化 page has its own guard.
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

const GOLDEN = './__identity__/settings-fold'

/** Every tab the overlay knows, the moved and legacy ones, and the default. */
const ROUTES = [
  '/settings',
  '/settings?tab=config:personalization',
  '/settings?tab=config:model',
  '/settings?tab=config:chat',
  '/settings?tab=config:appearance',
  '/settings?tab=config:workspace',
  '/settings?tab=config:safety',
  '/settings?tab=config:browser',
  '/settings?tab=config:memory',
  '/settings?tab=config:voice',
  '/settings?tab=config:advanced',
  '/settings?tab=config:nothing',
  '/settings?tab=providers',
  '/settings?tab=providers&pview=keys',
  '/settings?tab=providers&pview=custom-endpoints',
  '/settings?tab=providers&pview=local',
  '/settings?tab=gateway',
  '/settings?tab=connections',
  '/settings?tab=keybinds',
  '/settings?tab=keys',
  '/settings?tab=keys&kview=settings',
  '/settings?tab=keys&key=TAVILY_API_KEY',
  '/settings?tab=vault',
  '/settings?tab=vault&kind=login&label=GitHub',
  '/settings?tab=notifications',
  '/settings?tab=sessions',
  '/settings?tab=sessions&session=s-archived',
  '/settings?tab=about',
  '/settings?tab=billing',
  '/settings?tab=im',
  '/settings?tab=usage',
  '/settings?tab=mcp',
  '/settings?tab=plugins&plugin=demo',
  '/settings?tab=config:model&aux=vision',
  '/settings?tab=config:advanced&field=agent.max_turns'
]

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
] as const)('%s: the Settings overlay', (mode, singleThread, toolView) => {
  describe.each(ACCOUNT_KINDS)('%s', account => {
    function seed() {
      seedAccount(account)
      // Tool view first: switch-on-then-developer would pass through product mode on the way.
      setToolViewMode(toolView)
      setSingleThreadFlagForTest(singleThread)
    }

    it('opens on its default page: header, rail, footer', async () => {
      seed()

      const { html } = await renderSettings(<SettingsView onClose={() => undefined} />, '/settings')

      await expect(html).toMatchFileSnapshot(`${GOLDEN}/shell-${mode}-${account}.html`)
    })

    it('lands every tab on the same page with the same rail', async () => {
      seed()

      const tabs: Record<string, unknown> = {}

      for (const route of ROUTES) {
        const { location, page, rail } = await renderSettings(<SettingsView onClose={() => undefined} />, route)
        tabs[route] = { location, page, rail: rail.join(' ') }
      }

      await expect(JSON.stringify(tabs, null, 2) + '\n').toMatchFileSnapshot(`${GOLDEN}/tabs-${mode}-${account}.json`)
    })
  })
})
