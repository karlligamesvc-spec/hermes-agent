import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useQuickEntryBridge } from '@/app/contrib/hooks/use-quick-entry-bridge'
import { QuickEntryApp } from '@/app/quick-entry/quick-entry-app'
import { QuickEntrySettings } from '@/app/settings/quick-entry-settings'
import { I18nProvider, type Locale } from '@/i18n'
import { QUICK_ENTRY_COPY, QUICK_ENTRY_LOCALE_KEY } from '@/i18n/quick-entry'
import {
  $quickEntry,
  QUICK_ENTRY_DEFAULT_SHORTCUT,
  type QuickEntrySessionOption,
  type QuickEntryStatePush,
  type QuickEntryStatus
} from '@/store/quick-entry'
import { $gatewayState, $sessions } from '@/store/session'
import { englishWords, readableText } from '@/test/zh-copy'
import type { SessionInfo } from '@/types/hermes'

// hc-1001 identity-layer guard, the Quick Entry half of hc-589's.
//
// The global-shortcut mini window is a separate renderer with no I18nProvider,
// so it never saw the language the app was in: it said "Ask Hermes…", "Send to",
// "Current chat" and "New session" on a Chinese install, and named the product
// upstream's way. Its Settings rows read keys zh never had, so they fell back to
// English without an error. Nothing here is on a feature checklist, which is
// why it rode along unnoticed until hc-994 summoned the window.

const DESKTOP_ROOT = resolve(__dirname, '..')
const CHINESE_LOCALES: Locale[] = ['zh', 'zh-hant']
const HERMES = /hermes/i

// What the main window pushes: Chinese titles plus one session with neither a
// title nor a preview, so only the window's own copy can produce a Latin word.
const SESSIONS: QuickEntrySessionOption[] = [
  { id: 'sess-1', title: '抖音选题：收纳神器' },
  { id: 'sess-2', title: '' }
]

interface QuickEntryStub {
  dismiss: ReturnType<typeof vi.fn>
  getSettings?: ReturnType<typeof vi.fn>
  onShown: (callback: () => void) => () => void
  onState: (callback: (payload: QuickEntryStatePush) => void) => () => void
  onSubmit?: (callback: (payload: unknown) => void) => () => void
  pushState?: ReturnType<typeof vi.fn>
  setSettings?: ReturnType<typeof vi.fn>
  submit: ReturnType<typeof vi.fn>
}

let pushToWindow: ((payload: QuickEntryStatePush) => void) | null = null

function installBridge(extra: Partial<QuickEntryStub> = {}): QuickEntryStub {
  const quickEntry: QuickEntryStub = {
    dismiss: vi.fn(),
    onShown: () => () => {},
    onState: callback => {
      pushToWindow = callback

      return () => {
        pushToWindow = null
      }
    },
    submit: vi.fn(),
    ...extra
  }

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { quickEntry }

  return quickEntry
}

function renderWindow(locale: Locale | null, state: QuickEntryStatePush = { connected: true, sessions: SESSIONS }) {
  if (locale) {
    window.localStorage.setItem(QUICK_ENTRY_LOCALE_KEY, locale)
  }

  installBridge()
  const view = render(<QuickEntryApp />)

  act(() => pushToWindow?.(state))

  return view
}

const input = () => screen.getByRole('textbox')

beforeEach(() => {
  window.localStorage.clear()
  window.document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  pushToWindow = null
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
})

describe('identity: the Quick Entry window speaks Chinese and says APEX', () => {
  it.each(CHINESE_LOCALES)('has no English word and no Hermes at %s, connected or not', locale => {
    const view = renderWindow(locale)
    const connected = readableText(view.container)

    act(() => pushToWindow?.({ connected: false, sessions: SESSIONS }))
    const disconnected = readableText(view.container)

    for (const text of [connected, disconnected]) {
      expect(englishWords(text)).toEqual([])
      expect(text).not.toMatch(HERMES)
    }

    // Both placeholders were seen, so neither state went unchecked.
    expect(connected).toContain(QUICK_ENTRY_COPY[locale].window.placeholder)
    expect(disconnected).toContain(QUICK_ENTRY_COPY[locale].window.disconnected)
  })

  it('shows the Simplified Chinese words, and names a session that has no title', () => {
    renderWindow('zh')

    expect(input().getAttribute('placeholder')).toBe('问 APEX 点什么…')
    expect(input().getAttribute('aria-label')).toBe('快速输入')
    expect(screen.getByText('发到')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '发到哪个会话' })).toBeTruthy()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      '当前会话',
      '新建会话',
      '抖音选题：收纳神器',
      '无标题会话'
    ])

    act(() => pushToWindow?.({ connected: false, sessions: [] }))
    expect(input().getAttribute('placeholder')).toBe('未连接，打开 APEX 重新连接')
  })

  it('opens in Chinese before the main window has said anything', () => {
    // A first launch can summon the window before the primary renderer writes
    // its language. China-first, like main.tsx's initialLocale.
    renderWindow(null)

    expect(input().getAttribute('placeholder')).toBe('问 APEX 点什么…')
    expect(window.document.documentElement.lang).toBe('zh')
  })

  it('follows the main window to another language without being reopened', () => {
    renderWindow('zh')

    act(() => {
      window.localStorage.setItem(QUICK_ENTRY_LOCALE_KEY, 'en')
      window.dispatchEvent(new StorageEvent('storage', { key: QUICK_ENTRY_LOCALE_KEY, newValue: 'en' }))
    })

    expect(input().getAttribute('placeholder')).toBe('Ask APEX…')
    expect(screen.getAllByRole('option')[0].textContent).toBe('Current chat')
    expect(window.document.documentElement.lang).toBe('en')
  })

  it('says APEX in English too', () => {
    renderWindow('en')

    expect(input().getAttribute('placeholder')).toBe('Ask APEX…')
    act(() => pushToWindow?.({ connected: false, sessions: [] }))
    expect(input().getAttribute('placeholder')).toBe('Not connected — open APEX to reconnect')
  })
})

describe('identity: the Quick Entry rows in Settings speak Chinese', () => {
  const renderRows = (status: Omit<QuickEntryStatus, 'shortcut'>) => {
    installBridge({
      getSettings: vi.fn().mockResolvedValue({ ...status, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT }),
      setSettings: vi.fn()
    })

    return render(
      <I18nProvider configClient={null} initialLocale="zh">
        <QuickEntrySettings />
      </I18nProvider>
    )
  }

  afterEach(() =>
    $quickEntry.set({ enabled: true, error: null, registered: null, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT })
  )

  it.each<{ error: QuickEntryStatus['error']; status: string }>([
    { error: null, status: '快捷键已生效。' },
    { error: 'taken', status: '这个快捷键已被别的应用占用，请换一个。' },
    { error: 'invalid', status: '快捷键格式不对，至少要带一个修饰键。' }
  ])('has no English word and no Hermes when the shortcut is $error', async ({ error, status }) => {
    const view = renderRows({ enabled: true, error, registered: error === null })

    await waitFor(() => expect(screen.getByText(status)).toBeTruthy())
    expect(screen.getByText('快速输入')).toBeTruthy()

    // The field holds the chord in Electron's own key names (its value, and its
    // placeholder once cleared). That is the setting itself, not copy: pin it to
    // exactly the default chord so no sentence can hide in the placeholder.
    const field = screen.getByRole('textbox', { name: '快速输入快捷键' })

    expect(field.getAttribute('placeholder')).toBe(QUICK_ENTRY_DEFAULT_SHORTCUT)
    field.removeAttribute('placeholder')

    const text = readableText(view.container)

    expect(englishWords(text)).toEqual([])
    expect(text).not.toMatch(HERMES)
  })
})

describe('identity: every Quick Entry string has a Chinese twin', () => {
  // Each locale is a whole object, so TypeScript already refuses a missing key.
  // This catches the other way to fall back to English: a key that is there but
  // still holds the English text.
  const leaves = (value: unknown, path = ''): [string, string][] =>
    typeof value === 'string'
      ? [[path, value]]
      : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
          leaves(child, path ? `${path}.${key}` : key)
        )

  const english = Object.fromEntries(leaves(QUICK_ENTRY_COPY.en))

  it.each(CHINESE_LOCALES)('%s copy is Chinese, not English left in place', locale => {
    const strings = leaves(QUICK_ENTRY_COPY[locale])

    expect(strings.map(([path]) => path)).toEqual(Object.keys(english))

    for (const [path, text] of strings) {
      expect({ path, words: englishWords(text) }).toEqual({ path, words: [] })
      expect(text, path).not.toBe(english[path])
    }
  })

  it.each(Object.keys(QUICK_ENTRY_COPY) as Locale[])('%s never names Hermes', locale => {
    for (const [path, text] of leaves(QUICK_ENTRY_COPY[locale])) {
      expect(text, path).not.toMatch(HERMES)
    }
  })

  it('keeps the old catalog keys gone, so nothing reads the English-only copy again', () => {
    // Upstream's `settings.quickEntry` existed in en and ar only; zh read it as
    // English. It lives in i18n/quick-entry.ts now.
    for (const file of ['en.ts', 'zh.ts', 'zh-hant.ts', 'ja.ts', 'ar.ts', 'types.ts']) {
      expect(readFileSync(join(DESKTOP_ROOT, 'src', 'i18n', file), 'utf8'), file).not.toMatch(/\bquickEntry:/)
    }
  })
})

describe('identity: the main window hands its language to Quick Entry', () => {
  function Bridge() {
    useQuickEntryBridge({ startFreshSessionDraft: vi.fn(), submitText: vi.fn() })

    return null
  }

  const session = (id: string, title: null | string, preview: null | string) =>
    ({ id, preview, title }) as unknown as SessionInfo

  afterEach(() => {
    $sessions.set([])
    $gatewayState.set('idle')
  })

  it('stores the language it shows and pushes untitled sessions without their id', async () => {
    const pushState = vi.fn()

    installBridge({ onSubmit: () => () => {}, pushState })
    $gatewayState.set('open')
    $sessions.set([session('20261020_093000_ab12cd', '周报', null), session('20261020_101500_ef34gh', null, null)])

    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <Bridge />
      </I18nProvider>
    )

    await waitFor(() => expect(window.localStorage.getItem(QUICK_ENTRY_LOCALE_KEY)).toBe('zh'))
    expect(pushState).toHaveBeenLastCalledWith({
      connected: true,
      sessions: [
        { id: '20261020_093000_ab12cd', title: '周报' },
        { id: '20261020_101500_ef34gh', title: '' }
      ]
    })
  })
})
