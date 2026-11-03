/**
 * hc-1098 identity guard harness. Renders the top of a settings page the way
 * Settings mounts it — the title (SettingsSurfaceHeader), the 「应用于」 row
 * (SettingsProfileScope) and, for the model / tier page, ModelSection — exactly
 * the way the goldens beside this file were recorded on fork main 966a3aa618,
 * before hc-1098 changed the row. It must keep using only APIs that main
 * already had: the same file recorded the goldens there.
 *
 * The caller sets the switches (single_thread, multi_bot, tool view) and mocks
 * `@/hermes` (settings-scope-identity.test.tsx); this file seeds the profiles,
 * the roster, the account and the scope each case reads.
 */
import { useStore } from '@nanostores/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect } from 'vitest'

import { ModelSection } from '@/app/settings/model-tier-settings'
import { SettingsProfileScope } from '@/app/settings/profile-scope'
import { SettingsSurfaceHeader } from '@/app/settings/settings-multi-bot'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { $settingsRequestProfile, $settingsScopeOverride } from '@/store/settings-scope'
import { botRosterFrom, resetBotRosterForTest } from '@/store/single-thread-bots'
import type { ProfileInfo } from '@/types/hermes'

/** APEX plus the two assistants M7 made on 0.17.66: directory names apex-bot-2 / apex-bot-3. */
const ROWS = [
  { is_default: true, name: 'default' },
  { name: 'apex-bot-2', ui_meta: { apex: { created: 1, name: '剪辑助手', origin: 'product' } } },
  { name: 'apex-bot-3', ui_meta: { apex: { created: 2, name: '小红书文案', origin: 'product' } } }
]

/**
 * Whose settings are open: APEX on screen; another assistant on screen (M7's
 * 剪辑助手); APEX on screen with the pages pointed at another one (a chip
 * clicked earlier).
 */
export type ScopeState = 'apex' | 'bot' | 'override'

const SCOPES: Record<ScopeState, { active: string; override: null | string }> = {
  apex: { active: 'default', override: null },
  bot: { active: 'apex-bot-2', override: null },
  override: { active: 'default', override: 'apex-bot-3' }
}

export function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

/** An APEX account in tier mode, three profiles on disk, the roster the sidebar shows, and `state`'s scope. */
export function seedScopeState(state: ScopeState): void {
  setRuntimeI18nLocale('zh')
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: true,
    status: 'signed-in'
  })
  $profiles.set(
    ROWS.map(
      row =>
        ({ has_env: false, is_default: Boolean(row.is_default), model: null, name: row.name }) as unknown as ProfileInfo
    )
  )
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  // The active profile first: a switch drops any override (settings-scope.ts).
  $activeGatewayProfile.set(SCOPES[state].active)
  $settingsScopeOverride.set(SCOPES[state].override)
}

export function resetScopeState(): void {
  cleanup()
  $settingsScopeOverride.set(null)
  $activeGatewayProfile.set('default')
  $profiles.set([])
  resetBotRosterForTest()
  setRuntimeI18nLocale('en')
}

function SettingsTop({ tier }: { tier: boolean }) {
  // ConfigSettings hands ModelSection the request form of the scope.
  const scopeProfile = useStore($settingsRequestProfile)

  return (
    <>
      <SettingsSurfaceHeader description="说明" title="设置" titleId="settings-surface-title" />
      <SettingsProfileScope className="mb-5" />
      {tier ? <ModelSection scopeProfile={scopeProfile} /> : null}
    </>
  )
}

/** The page's top, normalized; the tier page once its tier and availability have loaded. */
export async function settingsTopHtml(tier: boolean): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <SettingsTop tier={tier} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  if (tier) {
    await waitFor(() => {
      expect(view.container.querySelector('[data-tier="flash"]')?.getAttribute('aria-checked')).toBe('true')
      expect(view.container.querySelector('[data-tier="pro"]')?.getAttribute('data-state')).toBe('available')
    })
  }

  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  return normalized(view.container.innerHTML)
}
