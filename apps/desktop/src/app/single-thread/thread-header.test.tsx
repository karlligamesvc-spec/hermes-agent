import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $sessions } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import { makeSessionInfo } from '@/test/session-info'

import { SingleThreadHeader, useSingleThreadHeader } from './thread-header'

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  $sessions.set([
    makeSessionInfo({ _lineage_root_id: 'thread-root', id: 'thread-tip' }),
    makeSessionInfo({ id: 'older-chat' })
  ])
  noteMainThreadClaimed('default', 'thread-root')
})

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  $sessions.set([])
})

describe('hc-1014 the header over the one thread', () => {
  it.each([
    ['the switch off', false, 'product', 'thread-root', false],
    ['developer mode', true, 'technical', 'thread-root', false],
    ['the thread', true, 'product', 'thread-root', true],
    ['a later segment of the thread', true, 'product', 'thread-tip', true],
    ['the empty thread on `/`', true, 'product', null, true],
    ['an earlier conversation (keeps its title)', true, 'product', 'older-chat', false]
  ] as const)('%s → pill: %s', (_label, flag, toolView, selected, expected) => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)

    expect(renderHook(() => useSingleThreadHeader(selected)).result.current).toBe(expected)
  })

  it('shows only APEX: the avatar and the name, no title and no session menu', () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <SingleThreadHeader />
      </I18nProvider>
    )

    expect(container.querySelector('[data-single-thread-header]')?.textContent).toBe('APEX')
    expect(screen.getByLabelText('APEX').querySelector('[data-apex-avatar="idle"]')).toBeTruthy()
    expect(screen.getByLabelText('APEX').querySelector('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
