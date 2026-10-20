import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $creatorTipsCatalog, resetCreatorTipsForTest } from '@/store/creator-tips'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $tipsEnabled, resetTips } from '@/store/tips'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { remixRunningTurn } from '@/test/remix-turn'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

// hc-995: the real process block of a running 「拆爆款」 task carries the creator
// tip where the slow-step hint was. The 6-second wait is pinned in
// process/creator-tip.test.tsx; here it is zero so the real thread can show it.

vi.mock('@/store/creator-tips', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  CREATOR_TIP_DELAY_MS: 0
}))

stubThreadEnvironment()
stubThreadViewportSize()

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  resetCreatorTipsForTest()
  resetTips()
  $tipsEnabled.set(true)
  $activeSessionId.set('session-tips')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
})

describe('a running task in the thread', () => {
  it('shows the tip for the step it waits on, under the status line', async () => {
    $creatorTipsCatalog.set([
      {
        id: 'hook-first-3s',
        steps: ['media_transcribe'],
        text: { en: 'Lead with the result.', zh: '开头 3 秒决定完播：先给结果或冲突，别先自我介绍。' }
      }
    ])

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={remixRunningTurn()}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    const tip = await waitFor(() => {
      const node = container.querySelector('[data-process-block] [data-creator-tip="hook-first-3s"]')

      expect(node).not.toBeNull()

      return node!
    })

    expect(tip.textContent).toContain('小贴士')
    expect(container.querySelector('[data-process-slow-hint]')).toBeNull()
    expect(container.querySelector('[data-process-status][data-state="running"]')?.textContent).toContain('正在识别语音…')
  })

  it('without a catalog keeps the slow-step hint exactly as before', async () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={remixRunningTurn()}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    await waitFor(() =>
      expect(container.querySelector('[data-process-slow-hint]')?.textContent).toBe('这一步要久一点，你可以先去忙别的。')
    )
    expect(container.querySelector('[data-creator-tip]')).toBeNull()
  })
})
