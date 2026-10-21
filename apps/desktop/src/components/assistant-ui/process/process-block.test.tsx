import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { remixFailedTurn, remixLiveTurn } from '@/test/remix-turn'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'
import { Thread } from '../thread'
import { toolPresentVerb } from '../tool/run-summary'

// hc-973: the process area speaks English too — the same one line, the same
// steps — for a user who runs Desktop in English.

stubThreadEnvironment()
stubThreadViewportSize()

const renderEn = (messages = remixLiveTurn()) =>
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

beforeEach(() => {
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $activeSessionId.set('session-en')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
})

describe('the process area in English', () => {
  it('sums a finished task up as one line and opens onto its steps', async () => {
    const { container } = renderEn()

    await waitFor(() =>
      expect(container.querySelector('[data-process-status]')?.textContent).toContain(
        'Download video → Transcribe speech → Keyword trends → Search posts'
      )
    )
    expect(container.querySelector('[data-process-status]')?.textContent).toContain('Took 2m 10s')

    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }))

    const steps = await waitFor(() => {
      const text = container.querySelector('[data-process-steps]')?.textContent ?? ''

      expect(text).not.toBe('')

      return text
    })

    for (const expected of [
      'Downloaded 1 video, 1m 43s, 126K likes',
      'Got the transcript, 360 characters',
      'Trends for "家居好物"',
      'Found 40 posts'
    ]) {
      expect(steps).toContain(expected)
    }

    expect(screen.getByRole('button', { name: /Thought for 15s/ })).toBeTruthy()
  })

  it('offers the same three ways on from a stuck step', async () => {
    renderEn(remixFailedTurn())

    expect((await screen.findByRole('alert')).textContent).toContain("This step didn't get a result.")

    for (const name of ['Retry', 'Try another way', 'Give me what you have']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })
})

describe('the status line while a call is being drafted', () => {
  it('uses the step’s own words, before the call even starts', () => {
    setRuntimeI18nLocale('zh')

    expect(toolPresentVerb('social_download')).toBe('正在下载视频')
    expect(toolPresentVerb('mcp_shop__create_order')).toBe('正在处理')
  })
})

describe('developer mode', () => {
  it('is off until the user turns it on, and Settings calls it that', async () => {
    window.localStorage.removeItem('hermes.desktop.toolView.technical')
    vi.resetModules()

    const fresh = await import('@/store/tool-view')

    expect(fresh.$toolViewMode.get()).toBe('product')
    expect(TRANSLATIONS.zh.settings.appearance.toolViewTitle).toBe('开发者模式')
    expect(TRANSLATIONS.en.settings.appearance.toolViewTitle).toBe('Developer mode')
    expect(TRANSLATIONS.zh.settings.appearance.technical).toBe('开')
  })
})
