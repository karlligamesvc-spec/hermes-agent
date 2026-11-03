// First: the recording time zone, before any app module or fixture.
import './__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsView } from '@/app/settings'
import { $authState } from '@/store/auth'
import { $planUsage } from '@/store/plan-usage'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  accountPanelHtml,
  accountRowHtml,
  seedAccountMenuState,
  sidebarWithMenuHtml
} from './__identity__/account-menu/harness'
import { ACCOUNT_KINDS, renderSettings, seedAccount } from './__identity__/settings-fold/harness'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1133 identity guard (hard rule 11): the new account menu, its Settings pages
 * and the plans page exist only in single-thread product mode.
 *
 * The goldens under `__identity__/account-menu/` were recorded on fork main
 * bb742c3fbe with the same harness, before any hc-1133 code existed:
 * - with single_thread off and in developer mode, AccountPanel and the sidebar
 *   with the account menu open, and where the new `?tab=`s land for each account;
 * - in product mode, the row itself before it is opened, and where those tabs
 *   land for someone on their own key, who has no APEX account to manage.
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

const GOLDEN = './__identity__/account-menu'

/** The tabs hc-1133 adds to product mode, and the one whose page it extends. */
const NEW_ROUTES = ['/settings?tab=account', '/settings?tab=activity', '/settings?tab=plans', '/settings?tab=usage']

const signedOut = $authState.get()

function setMode(singleThread: boolean, toolView: 'product' | 'technical'): void {
  // Tool view first: switch-on-then-developer would pass through product mode on the way.
  setToolViewMode(toolView)
  setSingleThreadFlagForTest(singleThread)
}

async function landings(): Promise<string> {
  const tabs: Record<string, unknown> = {}

  for (const route of NEW_ROUTES) {
    const { location, page, rail } = await renderSettings(<SettingsView onClose={() => undefined} />, route)
    tabs[route] = { location, page, rail: rail.join(' ') }
  }

  return JSON.stringify(tabs, null, 2) + '\n'
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $authState.set(signedOut)
  $planUsage.set(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

afterAll(restoreRecordingTimeZone)

describe.each([
  ['switch-off', false, 'product'],
  ['developer', true, 'technical']
] as const)('%s: nothing of the new menu shows', (mode, singleThread, toolView) => {
  it.each([
    ['business-chrome', true],
    ['plain', false]
  ] as const)('AccountPanel with its menu open, %s', async (chrome, businessChrome) => {
    seedAccountMenuState()
    setMode(singleThread, toolView)

    await expect(await accountPanelHtml(businessChrome)).toMatchFileSnapshot(`${GOLDEN}/panel-${mode}-${chrome}.html`)
  })

  it('the sidebar with the account menu open', async () => {
    seedAccountMenuState()
    setMode(singleThread, toolView)

    await expect(await sidebarWithMenuHtml()).toMatchFileSnapshot(`${GOLDEN}/sidebar-${mode}.html`)
  })

  it.each(ACCOUNT_KINDS)('the new tabs land where they did, %s', async account => {
    seedAccount(account)
    setMode(singleThread, toolView)

    await expect(await landings()).toMatchFileSnapshot(`${GOLDEN}/tabs-${mode}-${account}.json`)
  })
})

describe('product mode', () => {
  // By design the line changed on the branch: the row says `fast` is PRO, as the plans page does, and no number.
  it('the account row itself', async () => {
    seedAccountMenuState()
    setMode(true, 'product')

    await expect(await accountRowHtml()).toMatchFileSnapshot(`${GOLDEN}/row-product.html`)
  })

  it('someone on their own key has no account to manage: the new tabs land where they did', async () => {
    seedAccount('own-key')
    setMode(true, 'product')

    await expect(await landings()).toMatchFileSnapshot(`${GOLDEN}/tabs-product-own-key.json`)
  })
})
