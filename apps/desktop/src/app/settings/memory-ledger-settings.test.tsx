import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MEMORY_LEDGER_COPY } from '@/app/memory-ledger/memory-ledger-copy'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import type { DesktopMemoryLedger, DesktopMemoryLedgerRequest, DesktopMemoryLedgerResult } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { $memoryLedger } from '@/store/memory-ledger'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import { englishWords, readableText } from '@/test/zh-copy'

import { MemoryLedgerSettings } from './memory-ledger-settings'

type Bridge = (request: DesktopMemoryLedgerRequest) => Promise<DesktopMemoryLedgerResult>

const ID = '3f2a9c1d-0000-4000-8000-000000000001'

const LEDGER: DesktopMemoryLedger = {
  aboutYou: [{ content: '不露脸，女声配音', createdAt: '', id: ID, kind: 'about_you', source: 'desktop' }],
  limits: { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 },
  recent: []
}

const s = MEMORY_LEDGER_COPY.zh.settings

function install(bridge: Bridge, on = true) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: { get: async () => ({ payload: { desktop_features: { single_thread: on } } }) },
    managed: { memoryLedger: bridge }
  }
}

function renderSettings(locale: Locale = 'zh') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MemoryLedgerSettings />
    </I18nProvider>
  )
}

describe('它记得什么 settings (hc-1016)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    $memoryLedger.set({ accountId: null, ledger: null, status: 'idle' })
    setSingleThreadFlagForTest(false)
    setToolViewMode('product')
    $authState.set({
      account: { email: 'a@example.test', name: '小林', plan: 'free' },
      accountId: 'acc-1',
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
  })

  afterEach(() => {
    cleanup()
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('with the switch off it renders nothing at all and reads nothing', async () => {
    const bridge = vi.fn<Bridge>(async () => ({ ledger: LEDGER, ok: true }))

    install(bridge, false)
    const { container } = renderSettings()

    await waitFor(() => expect($memoryLedger.get().status).toBe('off'))
    expect(container.innerHTML).toBe('')
    expect(bridge.mock.calls).toEqual([[{ action: 'off' }]])
  })

  it('in 开发者模式 it stays out of the page even with the switch on', async () => {
    install(async () => ({ ledger: LEDGER, ok: true }))
    setToolViewMode('technical')
    const { container } = renderSettings()

    await waitFor(() => expect($memoryLedger.get().status).toBe('ready'))
    expect(container.innerHTML).toBe('')
  })

  it('lists both kinds in Chinese and says what a delete does', async () => {
    install(async () => ({ ledger: LEDGER, ok: true }))
    const { container } = renderSettings()

    expect(await screen.findByText('不露脸，女声配音')).toBeTruthy()
    expect(screen.getByText(s.title)).toBeTruthy()
    expect(screen.getByText(s.deleteNote)).toBeTruthy()
    expect(screen.getByText(s.groups.about_you.title)).toBeTruthy()
    expect(screen.getByText(s.groups.recent.hint(30))).toBeTruthy()
    expect(within(container.querySelector('[data-memory-kind="recent"]')!).getByText(s.empty)).toBeTruthy()
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('adds, edits and deletes through the bridge', async () => {
    const bridge = vi.fn<Bridge>(async request => {
      if (request.action === 'remove') {
        return { ledger: { ...LEDGER, aboutYou: [] }, ok: true }
      }

      if (request.action === 'edit') {
        return { ledger: { ...LEDGER, aboutYou: [{ ...LEDGER.aboutYou[0], content: request.content }] }, ok: true }
      }

      return { ledger: LEDGER, ok: true }
    })

    install(bridge)
    const { container } = renderSettings()
    await screen.findByText('不露脸，女声配音')
    const recent = within(container.querySelector('[data-memory-kind="recent"]') as HTMLElement)

    fireEvent.change(recent.getByLabelText(s.groups.recent.placeholder), { target: { value: ' 周三发了收纳三样 ' } })
    fireEvent.click(recent.getByRole('button', { name: s.add }))
    await waitFor(() =>
      expect(bridge).toHaveBeenCalledWith({ action: 'add', content: '周三发了收纳三样', kind: 'recent' })
    )

    fireEvent.click(screen.getByRole('button', { name: s.edit }))
    fireEvent.change(screen.getByLabelText(s.edit), { target: { value: '不露脸' } })
    fireEvent.click(screen.getByRole('button', { name: s.save }))
    await waitFor(() => expect(bridge).toHaveBeenCalledWith({ action: 'edit', content: '不露脸', id: ID }))
    expect(await screen.findByText('不露脸')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: s.remove }))
    await waitFor(() => expect(bridge).toHaveBeenCalledWith({ action: 'remove', id: ID }))
    await waitFor(() =>
      expect(within(container.querySelector('[data-memory-kind="about_you"]')!).getByText(s.empty)).toBeTruthy()
    )
  })

  it.each([
    ['sensitive_content', s.refusals.sensitive_content],
    ['ledger_full', s.refusals.ledger_full],
    [undefined, s.failed]
  ])('a refused add (%s) says why and keeps the draft', async (code, message) => {
    install(async request =>
      request.action === 'add'
        ? { ...(code ? { code } : {}), ledger: null, message: 'INVALID', ok: false }
        : { ledger: LEDGER, ok: true }
    )
    const { container } = renderSettings()
    await screen.findByText('不露脸，女声配音')
    const about = within(container.querySelector('[data-memory-kind="about_you"]') as HTMLElement)

    fireEvent.change(about.getByLabelText(s.groups.about_you.placeholder), { target: { value: '密码是 1234' } })
    fireEvent.click(about.getByRole('button', { name: s.add }))

    expect((await about.findByRole('alert')).textContent).toBe(message)
    expect((about.getByLabelText(s.groups.about_you.placeholder) as HTMLInputElement).value).toBe('密码是 1234')
  })

  it.each(['zh', 'zh-hant', 'en', 'ja', 'ar'] as const)('has every key in %s', locale => {
    const copy = MEMORY_LEDGER_COPY[locale]

    for (const value of [copy.settings.title, copy.settings.deleteNote, copy.noted.undo, copy.noted.line('x')]) {
      expect(value.trim()).not.toBe('')
    }

    expect(Object.keys(copy.settings.refusals).sort()).toEqual(Object.keys(s.refusals).sort())
  })
})
