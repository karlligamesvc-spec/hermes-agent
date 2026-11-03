/**
 * hc-1113: the quick window, as the user sees it. In 0.17.67 it kept saying
 * 「问 剪辑助手 点什么…」 after the main window had switched to APEX, and a line
 * that did not land simply vanished. The name now comes with every summon, and
 * a line that did not land is back in the input with why under it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QUICK_ENTRY_ASSISTANT_KEY, QUICK_ENTRY_LOCALE_KEY } from '@/i18n/quick-entry'
import type { QuickEntryStatePush } from '@/store/quick-entry'

import { QuickEntryApp } from './quick-entry-app'

const EDITOR = { name: '剪辑助手', profile: 'apex-bot-2' }
const APEX = { name: 'APEX', profile: 'default' }

let shown: ((payload?: null | QuickEntryStatePush) => void) | null = null
let pushed: ((payload: QuickEntryStatePush) => void) | null = null

function open(storedName: null | string = null) {
  window.localStorage.setItem(QUICK_ENTRY_LOCALE_KEY, 'zh')

  if (storedName) {
    window.localStorage.setItem(QUICK_ENTRY_ASSISTANT_KEY, storedName)
  }

  const submit = vi.fn()

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    quickEntry: {
      dismiss: vi.fn(),
      onShown: (callback: typeof shown) => {
        shown = callback

        return () => (shown = null)
      },
      onState: (callback: typeof pushed) => {
        pushed = callback

        return () => (pushed = null)
      },
      submit
    }
  }

  render(<QuickEntryApp />)

  return { input: () => screen.getByRole('textbox') as HTMLInputElement, submit }
}

beforeEach(() => window.localStorage.clear())

afterEach(() => {
  cleanup()
  shown = null
  pushed = null
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
})

describe('hc-1113 the window names the assistant on screen when summoned', () => {
  it('a summon carries the name, even when the storage event never reached the hidden window', () => {
    const w = open('剪辑助手')

    act(() => pushed?.({ assistant: EDITOR, connected: true, sessions: [] }))
    expect(w.input().placeholder).toBe('问 剪辑助手 点什么…')

    // The main window switched to APEX; localStorage still says 剪辑助手 here.
    act(() => shown?.({ assistant: APEX, connected: true, sessions: [] }))
    expect(w.input().placeholder).toBe('问 APEX 点什么…')
  })

  it('and the line typed then goes to that assistant', () => {
    const w = open()

    act(() => shown?.({ assistant: EDITOR, connected: true, sessions: [] }))
    fireEvent.change(w.input(), { target: { value: '标题写 3 个' } })
    fireEvent.keyDown(w.input(), { key: 'Enter' })

    expect(w.submit).toHaveBeenCalledWith({ assistant: EDITOR, target: 'current', text: '标题写 3 个' })
  })

  it('with one assistant the push names none and the window says APEX, as before', () => {
    const w = open()

    act(() => shown?.({ connected: true, sessions: [] }))

    expect(w.input().placeholder).toBe('问 APEX 点什么…')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('hc-1113 a line that did not land comes back with why', () => {
  it.each([
    ['busy', '剪辑助手', '剪辑助手 还在回上一条，这句还没发。等它说完再按回车。'],
    ['switch', '剪辑助手', '没能打开 剪辑助手，这句还没发。再按一次回车试试。'],
    ['refused', '剪辑助手', '这句没送到 剪辑助手。再按一次回车试试。'],
    ['no-answer', null, '这句没送到 APEX。再按一次回车试试。'],
    // The app's window, not an assistant: APEX stays APEX.
    ['no-window', '剪辑助手', 'APEX 主窗口没开着，这句没发出去。打开 APEX 再按回车。']
  ] as const)('%s', (reason, name, words) => {
    const w = open()

    act(() =>
      shown?.({
        assistant: EDITOR,
        connected: true,
        failure: { name, reason, text: '标题写 3 个' },
        sessions: []
      })
    )

    expect(w.input().value).toBe('标题写 3 个')
    expect(screen.getByRole('alert').textContent).toBe(words)
  })

  it('a freshly loaded window gets it through the state replay too', () => {
    const w = open()

    act(() =>
      pushed?.({ connected: true, failure: { name: null, reason: 'no-window', text: '再试一次' }, sessions: [] })
    )

    expect(w.input().value).toBe('再试一次')
    expect(screen.getByRole('alert').getAttribute('data-quick-entry-failure')).toBe('no-window')
  })
})
