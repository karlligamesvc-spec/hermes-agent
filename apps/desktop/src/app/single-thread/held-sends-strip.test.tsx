import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $heldSends, holdSend, resetHeldSendsForTest } from '@/store/held-sends'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botIntent,
  apexBot,
  namedBot,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { HeldSendsStrip, OPENING_LINE_DELAY_MS } from './held-sends-strip'

const { requestComposerInsert } = vi.hoisted(() => ({ requestComposerInsert: vi.fn() }))

vi.mock('@/app/chat/composer/focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerInsert
}))

function renderStrip() {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <HeldSendsStrip />
    </I18nProvider>
  )
}

/** The writer's conversation, selected and still loading. */
function writerLoading(): void {
  $activeGatewayProfile.set('writer')
  noteMainThreadClaimed('writer', 'writer-root')
  $selectedStoredSessionId.set('writer-root')
  $activeSessionId.set(null)
}

const opening = () => screen.queryByRole('status', { name: undefined })
const line = () => window.document.querySelector('[data-held-sends-opening]')

beforeEach(() => {
  vi.useFakeTimers()
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  $gatewayState.set('open')
  resetBotRosterForTest([apexBot(), namedBot({ name: 'writer', ui_meta: { apex: { name: '小红书文案' } } })])
  requestComposerInsert.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetHeldSendsForTest()
  resetMainThreadForTest()
  resetBotRosterForTest()
  $botIntent.set(null)
  $activeGatewayProfile.set('default')
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $gatewayState.set('idle')
})

describe('hc-1146 above the composer while an assistant’s conversation opens', () => {
  it('a held message shows at once as your bubble, waiting for the assistant by name', () => {
    writerLoading()
    holdSend('writer', { text: '标题写 3 个' })
    renderStrip()

    const item = window.document.querySelector('[data-held-send]')!

    expect(item.textContent).toContain('标题写 3 个')
    expect(item.textContent).toContain('小红书文案 接上后发送')
    expect(screen.getByRole('button', { name: '不发了，放回输入框' }).textContent).toBe('取消发送')
  })

  it('「取消发送」 takes it out of the line and puts the words back into the composer', () => {
    writerLoading()
    holdSend('writer', { text: '标题写 3 个' })
    renderStrip()

    fireEvent.click(screen.getByRole('button', { name: '不发了，放回输入框' }))

    expect($heldSends.get()).toEqual([])
    expect(requestComposerInsert).toHaveBeenCalledWith('标题写 3 个', { mode: 'block', target: 'main' })
    expect(window.document.querySelector('[data-held-sends]')).toBeNull()
  })

  it('the opening line stays while it opens, but only once that has taken 400 ms (a warm switch shows nothing)', () => {
    writerLoading()
    renderStrip()

    act(() => vi.advanceTimersByTime(OPENING_LINE_DELAY_MS - 50))
    expect(line()).toBeNull()

    act(() => vi.advanceTimersByTime(100))
    expect(line()?.textContent).toContain('正在唤醒 小红书文案…现在发的消息会先排着，接上就发。')

    act(() => $activeSessionId.set('rt-writer'))
    expect(line()).toBeNull()
  })

  it('a warm switch that lands within 400 ms never shows the line', () => {
    writerLoading()
    renderStrip()

    act(() => vi.advanceTimersByTime(200))
    act(() => $activeSessionId.set('rt-writer'))
    act(() => vi.advanceTimersByTime(1000))

    expect(line()).toBeNull()
    expect(window.document.querySelector('[data-held-sends]')).toBeNull()
  })

  it('once the assistant is up, what is still held waits for the reply to the one before', () => {
    writerLoading()
    holdSend('writer', { text: '第二句' })
    renderStrip()

    act(() => $activeSessionId.set('rt-writer'))

    expect(window.document.querySelector('[data-held-send]')?.textContent).toContain('上一条回完再发')
  })

  it('shows only the messages held for the assistant on screen', () => {
    writerLoading()
    holdSend('default', { text: '给 APEX 的' })
    holdSend('writer', { text: '给文案的' })
    renderStrip()

    expect([...window.document.querySelectorAll('[data-held-send]')].map(item => item.textContent)).toEqual([
      expect.stringContaining('给文案的')
    ])
  })

  it('while the engine itself is starting, the line names the assistant on screen (sends wait for it)', () => {
    writerLoading()
    $gatewayState.set('connecting')
    renderStrip()

    act(() => vi.advanceTimersByTime(1000))

    expect(line()?.textContent).toContain('正在唤醒 小红书文案…')
  })

  it.each([
    ['one assistant', () => setMultiBotFlagForTest(false)],
    ['developer mode', () => setToolViewMode('technical')]
  ])('%s: renders nothing at all', (_mode, enter) => {
    writerLoading()
    holdSend('writer', { text: '标题写 3 个' })
    enter()
    const { container } = renderStrip()

    act(() => vi.advanceTimersByTime(1000))

    expect(container.innerHTML).toBe('')
    expect(opening()).toBeNull()
  })
})
