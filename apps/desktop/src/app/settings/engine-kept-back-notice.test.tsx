// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateApply, DesktopRuntimeVersion } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { DESKTOP_UPDATE_COPY } from '@/i18n/desktop-update'
import { ENGINE_KEPT_BACK_COPY } from '@/i18n/engine-kept-back'

// hc-1033: a machine ran a 10-06 engine under every app version through 0.17.61 and the only sign was
// one desktop.log line. The About page now says so and offers the switch.
const switchMock = vi.fn<() => Promise<DesktopRuntimeUpdateApply>>()

vi.mock('@/store/runtime-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $runtimeVersion: atom<DesktopRuntimeVersion | null>(null),
    switchToBundledEngine: () => switchMock()
  }
})

import { $runtimeVersion } from '@/store/runtime-update'

import { EngineKeptBackNotice } from './engine-kept-back-notice'

const zh = ENGINE_KEPT_BACK_COPY.zh
// hc-1200: an engine version (calver, e.g. 2026.10.23, or its -fork.<key>) never reaches the copy.
const ENGINE_VERSION = /\d{4}\.\d{1,2}\.\d{1,2}|fork|a2e1a4b5/u
const reload = vi.fn()

function keptBack(reason: 'busy' | 'newer-or-unknown' | 'upgrade-failed') {
  $runtimeVersion.set({ ok: true, version: null, commit: null, branch: null, key: null, keptBack: { reason, bundledVersion: 'v2026.10.23-fork.a2e1a4b5' } })
}

function renderZh() {
  setRuntimeI18nLocale('zh')

  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <EngineKeptBackNotice />
    </I18nProvider>
  )
}

beforeEach(() => {
  switchMock.mockReset()
  reload.mockReset()
  $runtimeVersion.set(null)
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
})

afterEach(() => {
  cleanup()
})

describe('EngineKeptBackNotice (hc-1033)', () => {
  it('stays silent while the shipped engine runs', () => {
    $runtimeVersion.set({ ok: true, version: 'v2026.10.23-fork.a2e1a4b5', commit: null, branch: null, key: null, keptBack: null })
    renderZh()

    expect(screen.queryByTestId('engine-kept-back-banner')).toBeNull()
  })

  it.each(['busy', 'newer-or-unknown', 'upgrade-failed'] as const)('names the fix, and no engine version, when %s', reason => {
    keptBack(reason)
    renderZh()

    const banner = screen.getByTestId('engine-kept-back-banner')
    expect(banner.getAttribute('data-reason')).toBe(reason)
    expect(screen.getByText(zh.title)).toBeTruthy()
    expect(screen.getByText(zh.detail[reason])).toBeTruthy()
    expect(banner.textContent).not.toMatch(ENGINE_VERSION)
    expect(screen.getByRole('button', { name: zh.switchAction })).toBeTruthy()
  })

  it('reloads into the armed install', async () => {
    keptBack('newer-or-unknown')
    switchMock.mockResolvedValue({ ok: true, applied: true, reloadRequired: true })
    renderZh()

    fireEvent.click(screen.getByRole('button', { name: zh.switchAction }))

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(switchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ ok: true, applied: false, deferred: true }, zh.deferred],
    [{ ok: false, error: 'unsupported' }, DESKTOP_UPDATE_COPY.zh.errors.unsupported],
    [{ ok: false, error: 'preflight exploded' }, DESKTOP_UPDATE_COPY.zh.errors.generic]
  ])('says why nothing changed: %j', async (result, sentence) => {
    keptBack('upgrade-failed')
    switchMock.mockResolvedValue(result)
    renderZh()

    fireEvent.click(screen.getByRole('button', { name: zh.switchAction }))

    expect(await screen.findByText(sentence)).toBeTruthy()
    expect(reload).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: zh.switchAction }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('engine kept-back copy (hc-1033)', () => {
  it.each(Object.entries(ENGINE_KEPT_BACK_COPY))('%s: every sentence names its fix and APEX, never an engine version', (_locale, copy) => {
    for (const sentence of Object.values(copy.detail)) {
      expect(sentence).toContain(copy.switchAction)
      expect(sentence).toContain('APEX')
      expect(sentence).not.toMatch(ENGINE_VERSION)
    }
  })

  it('writes the Chinese sentences in Chinese, not the English fallback', () => {
    for (const locale of ['zh', 'zh-hant'] as const) {
      const copy = ENGINE_KEPT_BACK_COPY[locale]
      const text = [copy.title, copy.switchAction, copy.switching, copy.deferred, ...Object.values(copy.detail)].join(' ')
      // The product name is the only Latin word these sentences may carry.
      expect(text.replaceAll('APEX', '')).not.toMatch(/[A-Za-z]{3,}/u)
    }
  })
})
