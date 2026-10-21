// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider } from '@/i18n'
import { $introSplash, $introSplashShown } from '@/store/intro-splash'
import { $mainThread, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  accountMenuItems,
  normalized,
  renderHistory,
  renderSidebar,
  renderTranscript,
  seedShellState,
  transcriptHtml,
  TWO_DAY_TRANSCRIPT
} from './__identity__/single-thread-shell/render'
/**
 * hc-1014 identity guard (hard rule 11) for the single-thread shell.
 *
 * The harness pins America/Los_Angeles, the zone the goldens were recorded
 * in (time-zone.ts): fixtures are local wall-clock times and CI runs in UTC.
 *
 * Switch OFF (and developer mode with it on): the sidebar, the account menu, a
 * transcript spanning two days and the history page are byte-identical to the
 * goldens under `__identity__/single-thread-shell/`, which were recorded on
 * fork main 4ee99a81d6 with the same harness (render.tsx) before any
 * single-thread code existed. A diff there means the off path moved: fix the
 * code; re-record only for a change that is meant to reach every user.
 *
 * Switch ON in product mode: no Start page, no session list, no new-chat
 * button, one row into the conversation, 「更早的对话」 for old sessions, and
 * date / 「新的一段」 lines joining the segments into one timeline.
 */
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()
stubThreadViewportSize()

const DESKTOP_ROOT = __dirname
const golden = (name: string) => readFileSync(join(DESKTOP_ROOT, '__identity__', 'single-thread-shell', name), 'utf8')
const source = (...parts: string[]) => readFileSync(join(DESKTOP_ROOT, ...parts), 'utf8')

beforeEach(() => {
  seedShellState()
  resetMainThreadForTest()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  vi.useRealTimers()
})

/** An empty primary chat on `/`, the way the shell shows it before the first message. */
async function renderEmptyThread(): Promise<HTMLElement> {
  const view = render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={[]}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    </MemoryRouter>
  )

  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  return view.container
}

async function historyHtml(): Promise<string> {
  const view = renderHistory()

  await screen.findByText('脚本：9.9 元好物')

  return normalized(view.container.innerHTML) + '\n'
}

describe.each([
  ['the switch off', false, 'product'],
  ['developer mode with the switch on', true, 'technical']
] as const)('hc-1014 %s: byte-identical to main', (_label, flag, toolView) => {
  beforeEach(() => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
  })

  it('keeps the sidebar: 开始 row, ⌘N, session list and "+" all there', () => {
    expect(normalized(renderSidebar().container.innerHTML) + '\n').toBe(golden('sidebar.html'))
  })

  it('keeps the account menu, 历史会话 included', async () => {
    expect(JSON.stringify(await accountMenuItems(), null, 2) + '\n').toBe(golden('account-menu.json'))
  })

  it('keeps the transcript: no date or segment lines, 在新对话中分支 still offered', async () => {
    const container = await renderTranscript(TWO_DAY_TRANSCRIPT, () => undefined)

    expect(transcriptHtml(container) + '\n').toBe(golden('transcript-two-days.html'))
    expect(container.querySelector('[data-turn-divider]')).toBeNull()
  })

  it('keeps the history page', async () => {
    expect(await historyHtml()).toBe(golden('history.html'))
  })

  it('keeps the Start page splash under the Appearance toggle', () => {
    expect($introSplashShown.get()).toBe($introSplash.get())
  })

  it('draws no single-thread greeting in an empty chat', async () => {
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })

    expect((await renderEmptyThread()).querySelector('[data-single-thread-empty]')).toBeNull()
  })
})

describe('hc-1014 switch on, product mode: one conversation', () => {
  beforeEach(() => {
    setSingleThreadFlagForTest(true)
  })

  it('has no Start page', () => {
    expect($introSplash.get()).toBe(true)
    expect($introSplashShown.get()).toBe(false)
  })

  it('greets in the conversation when there is no thread yet, and stays blank while one is opening', async () => {
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })
    expect((await renderEmptyThread()).textContent).toContain('你好，我是 APEX，帮你做短视频的。')
    cleanup()

    noteMainThreadClaimed('default', 'chat-a')
    expect((await renderEmptyThread()).querySelector('[data-single-thread-empty]')).toBeNull()
  })

  it('has no session list, no 开始 / ⌘N row and no "+": one row opens the conversation', () => {
    const { container } = renderSidebar()

    expect([...container.querySelectorAll('[data-single-thread-nav]')].map(row => row.textContent)).toEqual([
      '对话',
      '沉浸式分析'
    ])
    expect(container.querySelector('[data-apex-business-nav="start"]')).toBeNull()
    expect(screen.queryByText('开始')).toBeNull()
    expect(screen.queryByText('选题：换季收纳')).toBeNull()
    expect(screen.queryByText('脚本：9.9 元好物')).toBeNull()
    expect(container.querySelector('kbd')).toBeNull()
    expect(screen.queryByRole('button', { name: /新对话|新建会话/ })).toBeNull()
  })

  it('names the old sessions 「更早的对话」 in the account menu', async () => {
    const items = await accountMenuItems()

    expect(items).toContain('更早的对话')
    expect(items).not.toContain('历史会话')
    expect(items.filter(item => item !== '更早的对话')).toEqual(
      (JSON.parse(golden('account-menu.json')) as string[]).filter(item => item !== '历史会话')
    )
  })

  it('lists every conversation but the thread on 「更早的对话」', async () => {
    noteMainThreadClaimed('default', 'chat-a')
    renderHistory()

    expect(await screen.findByRole('heading', { name: '更早的对话' })).toBeTruthy()
    expect(screen.getByText('脚本：9.9 元好物')).toBeTruthy()
    expect(screen.queryByText('选题：换季收纳')).toBeNull()
  })

  it('joins the segments into one timeline with a date per day and 「新的一段」 after idle hours', async () => {
    const container = await renderTranscript(TWO_DAY_TRANSCRIPT, () => undefined)
    const dividers = [...container.querySelectorAll('[data-turn-divider]')]

    expect(dividers.map(node => [node.getAttribute('data-turn-divider'), node.getAttribute('aria-label')])).toEqual([
      ['date', '5 月 1 日 周五'],
      ['segment', '新的一段'],
      ['date', '5 月 2 日 周六']
    ])
    expect(screen.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
  })
})

describe('hc-1014 the seams stay wired', () => {
  it('the chat view reads the single-thread splash, the gated composer and the gated header', () => {
    const chat = source('app', 'chat', 'index.tsx')

    // Off the thread (and with the switch off) the header is today's ChatHeader with the same props.
    expect(chat).toContain(
      'return useSingleThreadHeader(props.selectedSessionId) ? <SingleThreadHeader /> : <ChatHeader {...props} />'
    )
    expect(chat).toMatch(/\{isPrimary && \(\n\s+<PrimaryChatHeader\n/)

    expect(chat).toContain('const introSplash = useStore($introSplashShown)')
    expect(chat).toContain("import { ChatBar, ChatBarFallback } from '../single-thread/composer-gate'")
  })

  it('the sidebar surface swaps in the single-thread sidebar and the chat surface mounts the shell', () => {
    const surfaces = source('app', 'contrib', 'surfaces.tsx')

    expect(surfaces).toContain(
      '<SingleThreadSidebar currentView={currentView} onNavigate={latestActions.onNavigate} />'
    )
    expect(surfaces).toContain('useSingleThreadShell(actions.requestGateway)')
  })

  it('⌘T and the new-window shortcut go through the one-conversation guard', () => {
    const keybinds = source('app', 'hooks', 'use-keybinds.ts')

    expect(keybinds).toContain(
      "'session.newTab': () => openAnotherConversation(deps.openNewSessionTab, deps.startFreshSession)"
    )
    expect(keybinds).toContain(
      "'session.newWindow': () => openAnotherConversation(() => void openNewWindow(), deps.startFreshSession)"
    )
  })

  it('the tab strip "+" and the command palette read the one-conversation guard', () => {
    expect(source('components', 'pane-shell', 'tree', 'renderer', 'tree-group.tsx')).toContain(
      'const newSessionTabAction = useStore($newConversationTabAction)'
    )
    expect(source('app', 'command-palette', 'index.tsx')).toContain(
      'rankGroups(withoutNewConversationItems(unrankedGroups), search)'
    )
  })

  it('every turn row carries its divider slot', () => {
    expect(source('components', 'assistant-ui', 'thread', 'list.tsx')).toContain(
      "<TurnDivider index={group.kind === 'turn' ? group.indices[0] : group.index} />"
    )
  })
})
