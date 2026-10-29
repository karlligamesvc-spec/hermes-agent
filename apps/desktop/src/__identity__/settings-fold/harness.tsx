/**
 * hc-1109 identity guard harness for Settings. Renders the real SettingsView
 * (the caller mocks the pages to one-line markers), the real 个性化 page (the
 * caller mocks its parts) and the real command palette's settings rows and
 * searches, the way the goldens beside this file were recorded on fork main
 * 91b2f71eaf, before hc-1109 folded any section. It must keep using only APIs
 * main already had: the same file recorded the goldens there.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import {
  $commandPaletteSeed,
  closeCommandPalette,
  openCommandPalette,
  openCommandPalettePage
} from '@/store/command-palette'

/**
 * Who is signed in: an APEX account in tier mode, an APEX account without
 * tiers, or 「使用自己的密钥」 (no APEX account, the user's own model key).
 */
export type AccountKind = 'apex' | 'own-key' | 'tier'

export const ACCOUNT_KINDS: readonly AccountKind[] = ['tier', 'apex', 'own-key']

export function seedAccount(kind: AccountKind): void {
  setRuntimeI18nLocale('zh')
  $authState.set({
    ...$authState.get(),
    account: { email: 'creator@example.com', name: '' } as never,
    accountId: kind === 'own-key' ? null : 'acct-1',
    enabled: kind !== 'own-key',
    gateReason: null,
    modelTierMax: false,
    modelTiers: kind === 'tier',
    status: kind === 'own-key' ? 'disabled' : 'signed-in'
  })
}

export function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

function Providers({ children, route }: { children: ReactNode; route: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <I18nProvider configClient={null} initialLocale="zh">
          {children}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function LocationProbe({ onLocation }: { onLocation: (location: string) => void }) {
  const location = useLocation()
  onLocation(`${location.pathname}${location.search}`)

  return null
}

export interface SettingsRender {
  /** Where the router ended up (a tab redirect shows here). */
  location: string
  /** The page area's text: the caller's page marker. */
  page: string
  /** The rail's links in order by `data-tour` id, `*` on the active ones. */
  rail: string[]
  html: string
}

const ACTIVE_CLASSES = ['bg-(--ui-bg-tertiary)', 'font-medium']

/** The settings overlay opened at `route`, after its redirects ran. */
export async function renderSettings(view: ReactNode, route: string): Promise<SettingsRender> {
  let location = ''

  render(
    <Providers route={route}>
      {view}
      <LocationProbe onLocation={next => (location = next)} />
    </Providers>
  )
  await settle(30)

  const rail = [...document.querySelectorAll<HTMLElement>('[data-tour="overlay-nav"] [data-tour^="nav-"]')].map(
    link => {
      const active = ACTIVE_CLASSES.some(name => link.className.split(/\s+/).includes(name))

      return `${active ? '*' : ''}${(link.dataset.tour ?? '').slice('nav-'.length)}`
    }
  )

  const result = {
    html: normalized(document.body.innerHTML),
    location,
    page: (document.querySelector('main')?.lastElementChild?.textContent ?? '').trim(),
    rail
  }

  cleanup()

  return result
}

/** A page rendered alone, normalized. */
export async function pageHtml(view: ReactNode): Promise<string> {
  const { container } = render(<Providers route="/settings">{view}</Providers>)
  await settle(30)

  const html = normalized(container.innerHTML)

  cleanup()

  return html
}

/** Every group heading with its rows' visible text, for the palette opened on `page` with `seed` typed. */
export async function paletteGroups(
  palette: ReactNode,
  { page, seed }: { page?: string; seed?: string }
): Promise<{ heading: string; rows: string[] }[]> {
  render(<Providers route="/chat-a">{palette}</Providers>)

  act(() => {
    if (page) {
      openCommandPalettePage(page, seed)
    } else {
      $commandPaletteSeed.set(seed ?? null)
      openCommandPalette()
    }
  })
  await settle(150)

  const groups = [...document.querySelectorAll('[cmdk-group]')].map(group => ({
    heading: group.querySelector('[cmdk-group-heading]')?.textContent ?? '',
    rows: [...group.querySelectorAll('[cmdk-item]')].map(item => (item.textContent ?? '').trim())
  }))

  act(() => closeCommandPalette())
  cleanup()

  return groups
}
