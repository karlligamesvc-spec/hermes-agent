/**
 * hc-1132 identity guard harness: the real-profile consent dialog and the
 * Capabilities toggle, rendered for real in every language. The goldens beside
 * this file were recorded with this same file on fork main 12fa0a86e9, before
 * any hc-1132 code existed, so it must keep using only APIs main already had.
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'

import { RealProfileConsentDialog } from '@/app/chat/right-rail/real-profile-consent-dialog'
import { BrowserRealProfilePanel } from '@/app/settings/browser-real-profile-panel'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { Locale } from '@/i18n/types'
import { queryClient } from '@/lib/query-client'
import {
  $realProfilePromptClaim,
  $realProfilePromptDismissed,
  $realProfilePromptMuted
} from '@/store/real-profile-consent'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode, type ToolViewMode } from '@/store/tool-view'

export const LOCALES: readonly Locale[] = ['en', 'zh', 'zh-hant', 'ja', 'ar']

/** The modes outside product mode: the switch off, developer mode, and both. */
export const OUTSIDE_PRODUCT_MODE: readonly (readonly [string, boolean, ToolViewMode])[] = [
  ['the switch off', false, 'product'],
  ['developer mode', true, 'technical'],
  ['the switch off in developer mode', false, 'technical']
]

/** React's and Radix's generated ids count up per render in one test run; they are not what the guard is about. */
export function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

export interface ApiCall {
  body?: unknown
  method?: string
  path: string
  profile?: string
}

/** A bridge answering GET /api/config with `config` and any write with ok; returns what it was asked. */
export function installBridge(config: Record<string, unknown> = { browser: { use_real_profile: false } }): ApiCall[] {
  const calls: ApiCall[] = []

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      api: vi.fn(async (request: ApiCall) => {
        calls.push(request)

        return request.method === 'PUT' ? { ok: true } : config
      })
    }
  })

  return calls
}

export function removeBridge(): void {
  Reflect.deleteProperty(window, 'hermesDesktop')
}

export function seedMode(flag: boolean, toolView: ToolViewMode): void {
  window.localStorage.clear()
  queryClient.clear()
  setSingleThreadFlagForTest(flag)
  setToolViewMode(toolView)
  $realProfilePromptDismissed.set(false)
  $realProfilePromptMuted.set(false)
  $realProfilePromptClaim.set(null)
}

async function renderIn(locale: Locale, node: ReactNode): Promise<void> {
  setRuntimeI18nLocale(locale)

  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null} initialLocale={locale}>
        {node}
      </I18nProvider>
    </QueryClientProvider>
  )

  // The config read answers on a microtask; give it a few turns to paint.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

/** The dialog as a Browser tab mounts it. Radix portals it to the body, so that is what the guard reads. */
export async function renderDialog(locale: Locale): Promise<string> {
  await renderIn(locale, <RealProfileConsentDialog tabId="tab-fixture" />)

  return normalized(document.body.innerHTML) + '\n'
}

export async function renderPanel(locale: Locale): Promise<string> {
  await renderIn(locale, <BrowserRealProfilePanel />)

  return normalized(document.body.innerHTML) + '\n'
}
