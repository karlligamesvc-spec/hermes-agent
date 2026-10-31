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
import { BOT_SWITCH_WAIT_MS, botSwitchSettled } from '@/app/single-thread/quick-entry'
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

describe('hc-1113 the main window tells the quick window which assistant is on screen', () => {
  function pushes() {
    const pushState = vi.fn()

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      quickEntry: { onSubmit: () => () => {}, pushState }
    }

    function Bridge() {
      useQuickEntryBridge({ startFreshSessionDraft: vi.fn(), submitText: vi.fn() })

      return null
    }

    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <Bridge />
      </I18nProvider>
    )

    return () => pushState.mock.calls.at(-1)?.[0] as QuickEntryStatePush
  }

  it('with one assistant the push names none, exactly as before', () => {
    const last = pushes()

    expect(Object.keys(last()).sort()).toEqual(['connected', 'sessions'])
  })

  it('several on: the push names the one on screen, and a switch pushes again with the new one', async () => {
    severalOn()
    noteMainThreadClaimed('default', 'apex-root')
    const last = pushes()

    expect(last().assistant).toEqual({ name: '小A', profile: 'default' })

    await act(async () => $activeGatewayProfile.set('writer'))

    expect(last().assistant).toEqual({ name: '小红书文案', profile: 'writer' })
  })
})

describe('hc-1077 a capture made while a switch is landing waits for it', () => {
  it('goes now with one assistant, or when no switch is pending', async () => {
    await expect(botSwitchSettled(null)).resolves.toBe(true)

    severalOn()
    noteMainThreadClaimed('default', 'apex-root')

    await expect(botSwitchSettled(null)).resolves.toBe(true)
  })

  it('mid-switch: settles once the new assistant’s thread is on hand', async () => {
    severalOn()
    noteMainThreadClaimed('default', 'apex-root')
    $botIntent.set('writer')

    let landed: boolean | null = null
    void botSwitchSettled(null).then(value => (landed = value))

    // The order openBot produces: the engine lands, then the intent clears.
    await act(async () => {
      $activeGatewayProfile.set('writer')
      $botIntent.set(null)
    })
    expect(landed).toBeNull()

    await act(async () => $mainThread.set({ ids: [], profile: 'writer', rootId: null, status: 'loading', tipId: null }))
    expect(landed).toBeNull()

    await act(async () => noteMainThreadClaimed('writer', 'writer-root'))
    expect(landed).toBe(true)
  })

  it('hc-1113: a switch that never lands ends the wait as not landed (it used to wait again, forever)', async () => {
    vi.useFakeTimers()
    severalOn()
    noteMainThreadClaimed('default', 'apex-root')
    $botIntent.set('writer')

    let landed: boolean | null = null
    void botSwitchSettled(null).then(value => (landed = value))

    await vi.advanceTimersByTimeAsync(BOT_SWITCH_WAIT_MS - 1)
    expect(landed).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(landed).toBe(false)
  })

  it('the main window’s bridge holds the capture, then sends it into the new assistant’s thread', async () => {
    let capture: ((payload: unknown) => void) | null = null

    const receipt = vi.fn()

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      quickEntry: {
        onSubmit: (callback: (payload: unknown) => void) => {
          capture = callback

          return () => (capture = null)
        },
        pushState: vi.fn(),
        receipt
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

    await act(async () => capture?.({ id: 'qe-1', target: 'current', text: '标题写 3 个' }))
    expect(submitText).not.toHaveBeenCalled()
    expect(receipt).toHaveBeenCalledWith({ id: 'qe-1', stage: 'accepted' })

    await act(async () => {
      $activeGatewayProfile.set('writer')
      $botIntent.set(null)
    })
    expect(submitText).not.toHaveBeenCalled()

    await act(async () => noteMainThreadClaimed('writer', 'writer-root'))

    expect(submitText).toHaveBeenCalledWith('标题写 3 个')
    expect(receipt).toHaveBeenLastCalledWith({ id: 'qe-1', kind: 'current', profile: 'writer', stage: 'delivered' })
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
