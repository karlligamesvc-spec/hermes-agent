// First, before any app module: the shell harness renders dates in its recording zone.
import './__identity__/single-thread-shell/time-zone'

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatSwapOverlay } from '@/app/chat/chat-swap-overlay'
import { modelSlashHintNow } from '@/app/single-thread/bot-names'
import { SingleThreadEmptyState } from '@/app/single-thread/thread-empty'
import { approvalNotificationBody, plainApprovalSentence } from '@/components/assistant-ui/process/plain-steps'
import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $mainThread, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $busy, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { publishThreadStop } from '@/store/single-thread-stop'
import { setToolViewMode } from '@/store/tool-view'
import { EDITING_APPROVAL_CODE } from '@/test/editing-turn'
import { remixRunningTurn } from '@/test/remix-turn'

import {
  approvalFloatingHtml,
  approvalInlineHtml,
  clearProductState,
  composerHtml,
  emptyThreadHtml,
  memoryNotedHtml,
  runningTurnHtml,
  seedProductState
} from './__identity__/multi-bot/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1077: with several assistants on, every line that says 「APEX」 about the
 * assistant says the name of the one on screen — the header (pinned in
 * multi-bot-identity.test.tsx), 「给 X 发消息」, 「让 X 停下手上的事」, the activity
 * line and its face, an approval, 「X 记下了」, the greeting, `/model`, the
 * engine wake-up — while an approval notification from a background assistant
 * names that one. APEX's own lines stay exactly as they were (the goldens).
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const DESCRIPTION = 'execute_code script execution.'

afterAll(restoreRecordingTimeZone)

beforeEach(() => {
  resetMainThreadForTest()
  seedProductState()
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetBotRosterForTest(
    botRosterFrom(
      [
        { is_default: true, name: 'default', ui_meta: { apex: { name: '小A' } } },
        { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } }
      ],
      () => true
    )
  )
  $activeGatewayProfile.set('writer')
})

afterEach(() => {
  clearProductState()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  $activeGatewayProfile.set('default')
  resetMainThreadForTest()
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe('hc-1077 the lines name the assistant on screen', () => {
  it('the composer: 「给 小红书文案 发消息」, as placeholder and accessible name', async () => {
    const html = await composerHtml()

    expect(html).toContain('aria-label="给 小红书文案 发消息"')
    expect(html).not.toContain('APEX')
  })

  it('the activity line: its label and stop, wearing the assistant’s own face', async () => {
    const html = await runningTurnHtml()

    expect(html).toContain('aria-label="小红书文案 在做的事"')
    expect(html).toContain('fill="#C93A6E"')
    expect(html).not.toMatch(/APEX 在做的事|<circle[^>]*#6A4CEB/)
  })

  it('「停」 on the activity line: 「让 小红书文案 停下手上的事」', async () => {
    const unpublish = publishThreadStop(vi.fn())

    // A draft turn, not a stored session without a slice (that reads as idle).
    $selectedStoredSessionId.set(null)
    $busy.set(true)

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={remixRunningTurn()}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    const stop = await waitFor(() => {
      const node = container.querySelector('[data-single-thread-activity] [data-single-thread-stop]')

      expect(node).not.toBeNull()

      return node!
    })

    expect(stop.getAttribute('aria-label')).toBe('让 小红书文案 停下手上的事')
    $busy.set(false)
    unpublish()
  })

  it('an approval, inline and floating', async () => {
    expect(await approvalInlineHtml()).toContain('小红书文案 想在你的电脑上运行一段程序')
    clearProductState()
    seedProductState()
    expect(await approvalFloatingHtml()).toContain('小红书文案 想在你的电脑上运行一段程序')
  })

  it('「小红书文案 记下了」 under a reply (the ledger is still one for all)', async () => {
    expect(await memoryNotedHtml()).toContain('小红书文案 记下了：不露脸，只拍手')
  })

  it('the greeting of its empty thread, without today’s ideas (only APEX brings those, K7)', async () => {
    $authState.set({ ...$authState.get(), status: 'signed-out' })
    $mainThread.set({ ids: [], profile: 'writer', rootId: null, status: 'absent', tipId: null })

    const view = render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <SingleThreadEmptyState />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(view.container.textContent).toContain('我是 小红书文案，帮你做短视频的。')
    expect(view.container.querySelector('[data-first-open-ideas]')).toBeNull()
  })

  it('stays blank while the switch lands: the thread on hand is still the previous assistant’s', async () => {
    // The harness seeds APEX's empty thread; 小红书文案 is the one asked for.
    expect(await emptyThreadHtml()).toBe('\n')
  })

  it('`/model` and the engine wake-up', () => {
    setRuntimeI18nLocale('zh')

    expect(modelSlashHintNow()).toBe('不用选模型，小红书文案 会按要做的事自己安排。')

    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ChatSwapOverlay profile="writer" />
      </I18nProvider>
    )

    expect(screen.getByText(/小红书文案/)).toBeTruthy()
    expect(screen.queryByText(/writer/)).toBeNull()
  })

  it('APEX renamed: its lines carry the new name too', async () => {
    $activeGatewayProfile.set('default')

    expect(await composerHtml()).toContain('aria-label="给 小A 发消息"')
  })
})

describe('hc-1077 an approval notification names the assistant that asked', () => {
  beforeEach(() => setRuntimeI18nLocale('zh'))

  it.each([
    ['a background assistant', 'default', '小A 想在你的电脑上运行'],
    ['the one on screen', 'writer', '小红书文案 想在你的电脑上运行'],
    ['an engine with no profile named', undefined, '小A 想在你的电脑上运行']
  ])('%s', (_label, profile, start) => {
    expect(approvalNotificationBody(EDITING_APPROVAL_CODE, DESCRIPTION, profile)).toContain(start)
  })

  it('with one assistant the sentence is exactly what it was', () => {
    setMultiBotFlagForTest(false)

    const sentence = plainApprovalSentence(EDITING_APPROVAL_CODE, DESCRIPTION)

    expect(sentence.startsWith('APEX 想在你的电脑上运行')).toBe(true)
    expect(approvalNotificationBody(EDITING_APPROVAL_CODE, DESCRIPTION, 'writer')).toBe(sentence)
  })
})
