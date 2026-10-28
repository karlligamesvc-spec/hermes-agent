// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SingleThreadHeader } from '@/app/single-thread/thread-header'
import type { ClientSessionState } from '@/app/types'
import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { $mainThreadsByProfile, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botLastSessions,
  $botRoster,
  type BotProfileRow,
  botRosterFrom,
  canDeleteBot,
  canRestyleBot,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { $botSeenReplyIds } from '@/store/single-thread-presence'
import { $threadActivity } from '@/store/thread-signals'
import { setToolViewMode } from '@/store/tool-view'
import { remixRunningTurn } from '@/test/remix-turn'

import {
  approvalFloatingHtml,
  approvalInlineHtml,
  clearProductState,
  composerHtml,
  emptyThreadHtml,
  headerHtml,
  memoryNotedHtml,
  runningTurnHtml,
  seedProductState,
  sidebarHtml
} from './__identity__/multi-bot/render'
import { normalized, renderSidebar, seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1077 identity guard (hard rule 11) for several assistants in single-thread
 * mode (`desktop_features.multi_bot`).
 *
 * The goldens under `__identity__/multi-bot/` were recorded on fork main
 * 50a50d1bf7 with the same harness (render.tsx), before any multi-bot code
 * existed: every single-thread surface that names the assistant or reads the
 * one thread, in product mode (`product-*`) and in developer mode
 * (`developer-*`), both with single_thread on.
 *
 * - multi_bot off: every one of them is byte-identical, in both modes.
 * - multi_bot on in developer mode: the developer goldens, byte-identical.
 * - multi_bot on with single_thread off: hc-1014's switch-off sidebar golden.
 * - multi_bot on in product mode: the several-assistants sidebar (prototype
 *   v2 ⑥ and ⑨) and the header pill, recorded new here (`multi-bot-*`).
 *   hc-1078 re-recorded the two sidebars for the 「···」 it puts on the row on
 *   screen; that row's own button and every other row are unchanged.
 * - K6: APEX is always the first row, always the purple circle, and can never
 *   be deleted or restyled, whatever its profile.yaml says.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/multi-bot'

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  clearProductState()
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  $botSeenReplyIds.set({})
  $botLastSessions.set({})
  $activeGatewayProfile.set('default')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe.each([
  ['multi_bot off, product mode', 'product', 'product', false],
  ['multi_bot off, developer mode', 'developer', 'technical', false],
  ['multi_bot on, developer mode', 'developer', 'technical', true]
] as const)('single_thread on, %s: byte-identical to main', (_label, prefix, toolView, multiBot) => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedProductState()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(multiBot)
    setToolViewMode(toolView)
    // Several assistants listed: developer mode must not show them.
    resetBotRosterForTest(multiBot ? botRosterFrom(ROSTER_ROWS, () => true) : undefined)
  })

  it('the sidebar with a reply not yet seen', async () => {
    await expect(sidebarHtml('idle')).toMatchFileSnapshot(`${GOLDEN}/${prefix}-sidebar-idle.html`)
  })

  it('the sidebar while the assistant works', async () => {
    await expect(sidebarHtml('working')).toMatchFileSnapshot(`${GOLDEN}/${prefix}-sidebar-working.html`)
  })

  it('the composer', async () => {
    await expect(await composerHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-composer.html`)
  })

  it('a running turn', async () => {
    await expect(await runningTurnHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-running-turn.html`)
  })

  it('code waiting on approval, inline', async () => {
    await expect(await approvalInlineHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-approval-inline.html`)
  })

  it('code waiting on approval, as the floating bar', async () => {
    await expect(await approvalFloatingHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-approval-floating.html`)
  })

  it('a reply the assistant remembered something in (the 「记下了」 line in product mode)', async () => {
    const html = await memoryNotedHtml()

    expect(html.includes('data-memory-noted')).toBe(prefix === 'product')
    await expect(html).toMatchFileSnapshot(`${GOLDEN}/${prefix}-memory-noted.html`)
  })
})

describe('single_thread on, multi_bot off, product mode: the thread-only surfaces', () => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedProductState()
    setSingleThreadFlagForTest(true)
    setToolViewMode('product')
  })

  it('the header pill', async () => {
    await expect(headerHtml()).toMatchFileSnapshot(`${GOLDEN}/product-header.html`)
  })

  it('the empty thread', async () => {
    await expect(await emptyThreadHtml()).toMatchFileSnapshot(`${GOLDEN}/product-empty-thread.html`)
  })
})

const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'scripts', ui_meta: { apex: { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' } } }
]

const asChat = (turn: ReturnType<typeof remixRunningTurn>): ChatMessage[] =>
  turn.map(message => ({ id: message.id, parts: message.content as ChatMessage['parts'], role: message.role }))

const reply = (id: string, text: string): ChatMessage => ({ id, parts: [{ text, type: 'text' }], role: 'assistant' })

const state = (storedSessionId: string, extra: Partial<ClientSessionState>) =>
  ({ busy: false, messages: [], needsInput: false, storedSessionId, ...extra }) as unknown as ClientSessionState

const found = (profile: string, id: string) => ({
  ids: [id],
  profile,
  rootId: id,
  status: 'found' as const,
  tipId: id
})

/** Prototype v2 ⑥ / ⑨: three assistants, the one on screen and two in the background. */
function seedThreeAssistants(onScreen: 'default' | 'writer'): void {
  seedShellState()
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetBotRosterForTest(botRosterFrom(ROSTER_ROWS, () => true))
  $activeGatewayProfile.set(onScreen)
  $mainThreadsByProfile.set({
    default: found('default', 'chat-a'),
    scripts: found('scripts', 'scripts-root'),
    writer: found('writer', 'writer-root')
  })
  noteMainThreadClaimed(onScreen, onScreen === 'default' ? 'chat-a' : 'writer-root')
  $selectedStoredSessionId.set(onScreen === 'default' ? 'chat-a' : 'writer-root')
  $botLastSessions.set({ scripts: { id: 'scripts-root', preview: '好，定稿了。下次换款直接丢链接' } })

  if (onScreen === 'default') {
    // ⑥: APEX on screen cutting, 小红书文案 replied in the background.
    $threadActivity.set({ text: '在剪 · 第 2 镜，共 4 镜', waiting: false })
    $botSeenReplyIds.set({ writer: 'w-1' })
    $sessionStates.set({
      apex: state('chat-a', { busy: true }),
      writer: state('writer-root', { messages: [reply('w-1', '收纳那条'), reply('w-2', '标题写好了 3 个')] })
    })
  } else {
    // ⑨: on 小红书文案, APEX still working in the background.
    $sessionStates.set({
      apex: state('chat-a', { busy: true, messages: asChat(remixRunningTurn()) }),
      writer: state('writer-root', { messages: [reply('w-2', '标题写好了 3 个，要哪个？')] })
    })
  }
}

describe('multi_bot on, single_thread off: the sidebar is still hc-1014’s switch-off one', () => {
  it('byte for byte', () => {
    seedShellState()
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(botRosterFrom(ROSTER_ROWS, () => true))

    expect(normalized(renderSidebar().container.innerHTML) + '\n').toBe(
      readFileSync(join(__dirname, '__identity__', 'single-thread-shell', 'sidebar.html'), 'utf8')
    )
  })
})

describe('multi_bot on, product mode: several assistants (recorded new for hc-1077)', () => {
  it('⑥ the sidebar on APEX, one assistant replied in the background', async () => {
    seedThreeAssistants('default')

    await expect(normalized(renderSidebar('/chat-a', 'chat').container.innerHTML) + '\n').toMatchFileSnapshot(
      `${GOLDEN}/multi-bot-sidebar.html`
    )
  })

  it('⑨ the sidebar on another assistant, APEX still working in the background', async () => {
    setRuntimeI18nLocale('zh')
    seedThreeAssistants('writer')

    const html = normalized(renderSidebar('/writer-root', 'chat').container.innerHTML) + '\n'

    expect(html).toContain('正在识别语音…')
    await expect(html).toMatchFileSnapshot(`${GOLDEN}/multi-bot-sidebar-switched.html`)
  })

  it('the header pill on another assistant: its face and its name', async () => {
    seedThreeAssistants('writer')

    const view = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <SingleThreadHeader />
      </I18nProvider>
    )

    await expect(normalized(view.container.innerHTML) + '\n').toMatchFileSnapshot(`${GOLDEN}/multi-bot-header.html`)
  })
})

describe('K6: APEX is always the first row, the purple circle, and cannot be deleted', () => {
  it.each([
    ['listed last', [...ROSTER_ROWS.slice(1), ROSTER_ROWS[0]!]],
    [
      'given a look in its profile.yaml',
      [
        { is_default: true, name: 'default', ui_meta: { apex: { color: 'teal', created: 0, shape: 'drop' } } },
        ...ROSTER_ROWS.slice(1)
      ]
    ],
    ['missing from the list', ROSTER_ROWS.slice(1)]
  ])('when %s', (_label, rows) => {
    seedThreeAssistants('writer')
    resetBotRosterForTest(botRosterFrom(rows as BotProfileRow[], () => true))

    const { container } = renderSidebar('/writer-root', 'chat')
    const first = container.querySelector('[data-single-thread-nav="thread"]')!
    const body = first.querySelector('svg[data-apex-avatar] > :first-child')!
    const apex = $botRoster.get()[0]!

    expect(first.getAttribute('data-single-thread-bot')).toBe('default')
    expect(body.outerHTML).toBe('<circle cx="14" cy="14" fill="#6A4CEB" r="14"></circle>')
    expect([apex.isApex, canDeleteBot(apex), canRestyleBot(apex)]).toEqual([true, false, false])
    expect(
      $botRoster
        .get()
        .slice(1)
        .every(bot => canDeleteBot(bot) && canRestyleBot(bot))
    ).toBe(true)
  })
})
