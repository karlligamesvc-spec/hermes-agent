import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QUICK_ENTRY_LOCALE_KEY } from '@/i18n/quick-entry'

import { QuickEntryRoot } from './quick-entry-root'

// hc-1001: the window's crash screen is the app's own fallback, which reads
// its words from an I18nProvider. The window has none of its own, so without
// the one QuickEntryRoot gives the fallback it came up in English.
vi.mock('./quick-entry-app', () => ({
  QuickEntryApp: () => {
    throw new Error('渲染失败')
  }
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('QuickEntryRoot crash screen', () => {
  it('speaks the language the main window shows', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.localStorage.setItem(QUICK_ENTRY_LOCALE_KEY, 'zh')

    render(<QuickEntryRoot />)

    expect(screen.getByText('界面出错了')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新加载窗口' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开日志' })).toBeTruthy()
  })
})
