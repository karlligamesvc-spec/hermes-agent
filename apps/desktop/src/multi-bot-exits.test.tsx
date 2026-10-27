/**
 * hc-1077: the places outside the conversation that say which assistant
 * something belongs to, once several are on — the quick-entry window (and a
 * capture made mid-switch), the command palette's rows, and the settings page's
 * title. With one assistant each stays exactly as it was.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useQuickEntryBridge } from '@/app/contrib/hooks/use-quick-entry-bridge'
import { QuickEntryApp } from '@/app/quick-entry/quick-entry-app'
import { SettingsSurfaceHeader } from '@/app/settings/settings-multi-bot'
import { paletteSessionTitle } from '@/app/single-thread/bot-names'
import { BOT_SWITCH_WAIT_MS, holdUntilBotSwitchLands } from '@/app/single-thread/quick-entry'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { QUICK_ENTRY_ASSISTANT_KEY, QUICK_ENTRY_LOCALE_KEY, rememberQuickEntryAssistant } from '@/i18n/quick-entry'
import { $mainThread, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import type { QuickEntryStatePush } from '@/store/quick-entry'
import { $settingsScopeOverride } from '@/store/settings-scope'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $botIntent, botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'
import { makeSessionInfo } from '@/test/session-info'

const ROWS = [
  { is_default: true, name: 'default', ui_meta: { apex: { name: '小A' } } },
  { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }
]

function severalOn(): void {
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  window.localStorage.clear()
  $activeGatewayProfile.set('default')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $activeGatewayProfile.set('default')
  $settingsScopeOverride.set(null)
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
  setRuntimeI18nLocale('en')
})

describe('hc-1077 the quick-entry window names the assistant a capture reaches', () => {
  let push: ((payload: QuickEntryStatePush) => void) | null = null

  function renderWindow() {
    window.localStorage.setItem(QUICK_ENTRY_LOCALE_KEY, 'zh')
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      quickEntry: {
        dismiss: vi.fn(),
        onShown: () => () => {},
        onState: (callback: (payload: QuickEntryStatePush) => void) => {
          push = callback

          return () => (push = null)
        },
        submit: vi.fn()
      }
    }

    render(<QuickEntryApp />)
    act(() => push?.({ connected: true, sessions: [] }))

    return screen.getByRole('textbox')
  }

  it('with one assistant: 「问 APEX 点什么…」, as before', () => {
    expect(renderWindow().getAttribute('placeholder')).toBe('问 APEX 点什么…')
  })

  it('names the assistant the main window has on screen, and follows a switch live', () => {
    rememberQuickEntryAssistant('小红书文案')

    const input = renderWindow()

    expect(input.getAttribute('placeholder')).toBe('问 小红书文案 点什么…')

    act(() => {
      rememberQuickEntryAssistant('小A')
      window.dispatchEvent(new StorageEvent('storage', { key: QUICK_ENTRY_ASSISTANT_KEY }))
    })

    expect(input.getAttribute('placeholder')).toBe('问 小A 点什么…')
  })

  it('the main window clears the name when several assistants go off', () => {
    rememberQuickEntryAssistant('小红书文案')
    rememberQuickEntryAssistant(null)

    expect(window.localStorage.getItem(QUICK_ENTRY_ASSISTANT_KEY)).toBeNull()
  })
})

describe('hc-1077 a capture made while a switch is landing waits for it', () => {
  it('goes now with one assistant, or when no switch is pending', () => {
    const deliver = vi.fn()

    expect(holdUntilBotSwitchLands(deliver)).toBe(false)

    severalOn()
    noteMainThreadClaimed('default', 'apex-root')

    expect(holdUntilBotSwitchLands(deliver)).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('mid-switch: held until the new assistant’s thread is on hand, then delivered once', () => {
    severalOn()
    noteMainThreadClaimed('default', 'apex-root')
    $botIntent.set('writer')

    const deliver = vi.fn()

    expect(holdUntilBotSwitchLands(deliver)).toBe(true)

    // The order openBot produces: the engine lands, then the intent clears.
    act(() => {
      $activeGatewayProfile.set('writer')
      $botIntent.set(null)
    })
    expect(deliver).not.toHaveBeenCalled()

    act(() => $mainThread.set({ ids: [], profile: 'writer', rootId: null, status: 'loading', tipId: null }))
    expect(deliver).not.toHaveBeenCalled()

    act(() => noteMainThreadClaimed('writer', 'writer-root'))
    expect(deliver).toHaveBeenCalledTimes(1)

    act(() => $mainThread.set({ ...$mainThread.get() }))
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a switch that never lands still lets the capture through, after the wait', () => {
    vi.useFakeTimers()
    severalOn()
    noteMainThreadClaimed('default', 'apex-root')
    $botIntent.set('writer')

    const deliver = vi.fn()

    holdUntilBotSwitchLands(deliver)
    vi.advanceTimersByTime(BOT_SWITCH_WAIT_MS - 1)
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('the main window’s bridge holds the capture, then sends it into the new assistant’s thread', async () => {
    let capture: ((payload: unknown) => void) | null = null

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      quickEntry: {
        onSubmit: (callback: (payload: unknown) => void) => {
          capture = callback

          return () => (capture = null)
        },
        pushState: vi.fn()
      }
    }

    const submitText = vi.fn()

    function Bridge() {
      useQuickEntryBridge({ startFreshSessionDraft: vi.fn(), submitText })

      return null
    }

    severalOn()
    noteMainThreadClaimed('default', 'apex-root')
    $botIntent.set('writer')
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <Bridge />
      </I18nProvider>
    )

    act(() => capture?.({ target: 'current', text: '标题写 3 个' }))
    expect(submitText).not.toHaveBeenCalled()

    await act(async () => {
      $activeGatewayProfile.set('writer')
      $botIntent.set(null)
    })
    expect(submitText).not.toHaveBeenCalled()

    await act(async () => noteMainThreadClaimed('writer', 'writer-root'))

    expect(submitText).toHaveBeenCalledWith('标题写 3 个')
  })
})

describe('hc-1077 the command palette tells the assistants’ threads apart', () => {
  const thread = (profile: string, title = 'APEX 主线') => makeSessionInfo({ id: `${profile}-root`, profile, title })

  it('with one assistant every row keeps its title', () => {
    expect(paletteSessionTitle(thread('writer'))).toBe('APEX 主线')
  })

  it.each([
    ['APEX’s, by the name it has now', thread('default'), '和 小A 的对话'],
    ['another assistant’s', thread('writer'), '和 小红书文案 的对话'],
    ['a compression tip of it', thread('writer', 'APEX 主线 #3'), '和 小红书文案 的对话'],
    [
      'a row with no profile (an older gateway): APEX’s',
      makeSessionInfo({ id: 'x', title: 'APEX 主线' }),
      '和 小A 的对话'
    ],
    ['any other conversation', thread('writer', '选题：换季收纳'), '选题：换季收纳'],
    ['a title that only contains it', thread('writer', '回到 APEX 主线'), '回到 APEX 主线']
  ])('several on: %s', (_label, session, label) => {
    severalOn()

    expect(paletteSessionTitle(session)).toBe(label)
  })
})

describe('hc-1077 the settings page says whose settings they are', () => {
  function title(): string {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <SettingsSurfaceHeader description="说明" title="设置" titleId="t" />
      </I18nProvider>
    )

    return screen.getByRole('heading').textContent ?? ''
  }

  it('with one assistant: 设置', () => {
    $activeGatewayProfile.set('writer')

    expect(title()).toBe('设置')
  })

  it.each([
    ['the assistant on screen', 'writer', null, '小红书文案 的设置'],
    ['APEX, by its name', 'default', null, '小A 的设置'],
    ['the profile the pages were pointed at', 'default', 'writer', '小红书文案 的设置']
  ])('several on: %s', (_label, active, override, expected) => {
    severalOn()
    $activeGatewayProfile.set(active)
    $settingsScopeOverride.set(override)

    expect(title()).toBe(expected)
  })
})

describe('hc-1077 the seams stay wired', () => {
  const source = (...parts: string[]) => readFileSync(join(__dirname, ...parts), 'utf8')

  it('the command palette names its session rows through paletteSessionTitle', () => {
    expect(source('app', 'command-palette', 'index.tsx')).toContain('  title: paletteSessionTitle(session)\n')
  })

  it('the settings page draws its title through SettingsSurfaceHeader', () => {
    const settings = source('app', 'settings', 'index.tsx')

    expect(settings).toContain('<SettingsSurfaceHeader')
    expect(settings).not.toContain('<AccountSurfaceHeader')
  })
})
