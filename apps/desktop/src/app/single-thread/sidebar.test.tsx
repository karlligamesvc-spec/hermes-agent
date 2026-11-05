/**
 * hc-1061 G3: the single-thread sidebar as prototype v2 draws it, on the real
 * component with the switch on. The switch-off and developer-mode sidebars are
 * pinned byte for byte in src/single-thread-shell-identity.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceConversationPanel } from '@/app/chat/composer/voice-conversation-panel'
import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import type { AppView } from '@/app/routes'
import type { ClientSessionState } from '@/app/types'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { DesktopPlanUsageResult } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { $authState } from '@/store/auth'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $commandPaletteOpen } from '@/store/command-palette'
import { $mainThreadsByProfile, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $planUsage } from '@/store/plan-usage'
import { $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $botIntent, botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { resetThreadPresenceForTest } from '@/store/single-thread-presence'
import { $threadActivity, $threadInCall } from '@/store/thread-signals'
import { setToolViewMode } from '@/store/tool-view'

const noop = () => {}

const ACTIONS: SidebarActions = {
  onArchiveSession: noop,
  onBranchSession: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onManageCronJob: noop,
  onNavigate: noop,
  onNewSessionInWorkspace: noop,
  onNewSessionSplit: noop,
  onResumeSession: noop,
  onTriggerCronJob: noop
}

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function renderSidebar({ view = 'chat' }: { view?: AppView } = {}) {
  return render(
    <MemoryRouter initialEntries={['/thread-root']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={ACTIONS} currentView={view} />
        </SidebarProvider>
        <Location />
      </I18nProvider>
    </MemoryRouter>
  )
}

const reply = (id: string, text: string): ChatMessage => ({ id, parts: [{ text, type: 'text' }], role: 'assistant' })

const question = (sessionId: string) => ({
  choices: ['竖版', '横版'],
  multiSelect: false,
  question: '要竖版还是横版？',
  requestId: `q-${sessionId}`,
  sessionId
})

function threadState(extra: Partial<ClientSessionState> = {}) {
  $sessionStates.set({
    runtime: {
      busy: false,
      messages: [],
      needsInput: false,
      storedSessionId: 'thread-root',
      ...extra
    } as unknown as ClientSessionState
  })
}

function stubBridge({
  channels = [] as string[],
  planUsage
}: { channels?: string[]; planUsage?: () => Promise<DesktopPlanUsageResult> } = {}) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      imEntry: {
        list: vi.fn(async () => ({ channels: channels.map(channelId => ({ boundAt: 1, channelId, domain: '' })) }))
      },
      managed: planUsage ? { planUsage: vi.fn(planUsage) } : {}
    }
  })
}

const assistantRow = () => screen.getByRole('button', { name: /^APEX/ })
const statusLine = () => assistantRow().querySelector('[data-single-thread-status]')?.textContent ?? null

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  resetMainThreadForTest()
  noteMainThreadClaimed('default', 'thread-root')
  $selectedStoredSessionId.set('thread-root')
  $authState.set({
    account: { email: 'xiaoman@example.com', name: '小满', plan: '' },
    accountId: 'acct-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
  stubBridge()
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
  resetThreadPresenceForTest()
  $sessionStates.set({})
  $selectedStoredSessionId.set(null)
  $planUsage.set(null)
  $commandPaletteOpen.set(false)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('hc-1061 the layout, top to bottom', () => {
  it('APEX wordmark and search, one assistant row, then 在微信里找 APEX and the account', async () => {
    const { container } = renderSidebar()

    await waitFor(() => expect(container.querySelector('[data-single-thread-wechat="unbound"]')).not.toBeNull())

    const order = [
      container.querySelector('[data-apex-sidebar-brand]'),
      container.querySelector('[data-single-thread-nav="thread"]'),
      container.querySelector('[data-single-thread-wechat]'),
      container.querySelector('[data-single-thread-account]')
    ]

    expect(order.every(Boolean)).toBe(true)

    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }

    expect(container.querySelector('[data-apex-sidebar-brand]')?.textContent).toBe('APEX')
    expect(container.querySelectorAll('[data-single-thread-nav]')).toHaveLength(1)
    expect(screen.queryByText('沉浸式分析')).toBeNull()
    expect(screen.queryByText('对话')).toBeNull()
  })

  it('the search button opens the command palette', () => {
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    expect($commandPaletteOpen.get()).toBe(true)
  })

  it('the assistant row opens the thread and is the active row while it is on screen', () => {
    renderSidebar({ view: 'settings' })

    expect(assistantRow().className).not.toContain('bg-(--ui-row-active-background)')
    fireEvent.click(assistantRow())
    expect(screen.getByTestId('location').textContent).toBe('/thread-root')
  })
})

describe('hc-1146 the row on screen while a switch to another assistant is under way', () => {
  afterEach(() => {
    setMultiBotFlagForTest(false)
    resetBotRosterForTest()
    $botIntent.set(null)
  })

  it('is the clicked assistant’s, whose known conversation is already opened (no row without the highlight)', () => {
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(
      botRosterFrom(
        [
          { is_default: true, name: 'default' },
          { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }
        ],
        () => true
      )
    )
    $mainThreadsByProfile.set({
      ...$mainThreadsByProfile.get(),
      writer: { ids: ['writer-root'], profile: 'writer', rootId: 'writer-root', status: 'found', tipId: 'writer-root' }
    })
    // APEX's engine still answers; 小红书文案 was clicked and its thread opened at once.
    $botIntent.set('writer')
    $selectedStoredSessionId.set('writer-root')

    const { container } = renderSidebar()
    const row = (profile: string) => container.querySelector(`[data-single-thread-bot="${profile}"]`)!

    expect(row('writer').className).toContain('bg-(--ui-row-active-background)')
    expect(row('default').className).not.toContain('bg-(--ui-row-active-background)')

    // A click on it meanwhile stays in its conversation, not the previous assistant's.
    fireEvent.click(row('writer'))
    expect(screen.getByTestId('location').textContent).toBe('/writer-root')
  })
})

describe('hc-1061 the assistant row’s status line', () => {
  it('idle: the latest reply, as one line, with APEX blinking', () => {
    threadState({ messages: [reply('a1', '## **周三那条的脚本**写好了\n镜头 1')] })
    renderSidebar()

    expect(statusLine()).toBe('周三那条的脚本写好了')
    expect(assistantRow().querySelector('[data-apex-avatar]')?.getAttribute('data-apex-avatar')).toBe('idle')
  })

  it('working: the step the activity line names, APEX looking down', () => {
    threadState({ busy: true })
    $threadActivity.set({ text: '正在识别语音…', waiting: false })
    renderSidebar()

    expect(statusLine()).toBe('正在识别语音…')
    expect(assistantRow().getAttribute('data-state')).toBe('working')
    expect(assistantRow().querySelector('[data-apex-avatar]')?.getAttribute('data-apex-avatar')).toBe('working')
  })

  it('working with the conversation off screen: 在做事…', () => {
    threadState({ busy: true })
    renderSidebar({ view: 'settings' })

    expect(statusLine()).toBe('在做事…')
  })

  it.each([
    ['the activity line waits on the user', () => $threadActivity.set({ text: '等你决定', waiting: true })],
    // hc-1107: the question parked for the thread's session, not the session's needsInput flag.
    ['a question is parked on the thread', () => setClarifyRequest(question('runtime'))]
  ])('等你决定 when %s', (_label, arrange) => {
    threadState({ busy: true })
    arrange()
    renderSidebar()

    expect(statusLine()).toBe('等你决定')
  })

  it('通话中 while a call is open', () => {
    $threadInCall.set(true)
    renderSidebar()

    expect(statusLine()).toBe('通话中')
  })
})

describe('hc-1061 the unread dot', () => {
  it('shows for a reply that came in while the conversation was off screen, and clears on opening it', () => {
    threadState({ messages: [reply('a1', '第一句')] })
    const view = renderSidebar()

    act(() => threadState({ messages: [reply('a1', '第一句'), reply('a2', '早，今天能拍的 3 个')] }))
    expect(screen.queryByRole('img', { name: '有新消息' })).toBeNull() // on screen: seen as it arrives

    view.unmount()
    renderSidebar({ view: 'settings' })
    act(() =>
      threadState({ messages: [reply('a1', '第一句'), reply('a2', '早，今天能拍的 3 个'), reply('a3', '回来了？')] })
    )
    expect(screen.getByRole('img', { name: '有新消息' })).toBeTruthy()

    cleanup()
    renderSidebar({ view: 'chat' })
    expect(screen.queryByRole('img', { name: '有新消息' })).toBeNull()
  })
})

describe('hc-1061 在微信里找 APEX', () => {
  it.each([
    [['weixin'], '已绑定'],
    [['feishu'], '扫一下就绑上'],
    [[], '扫一下就绑上']
  ])('bindings %j → %s, and it opens the IM entry page', async (channels, subtitle) => {
    stubBridge({ channels })
    renderSidebar()

    const row = await screen.findByRole('button', { name: new RegExp(`在微信里找 APEX.*${subtitle}`) })

    fireEvent.click(row)
    expect(screen.getByTestId('location').textContent).toBe('/im-entry')
  })
})

describe('hc-1061 the account row', () => {
  const ok = (usage: DesktopPlanUsageResult['usage']) => async (): Promise<DesktopPlanUsageResult> => ({
    ok: true,
    usage
  })

  const accountLine = () =>
    screen.getByRole('button', { name: '打开账户菜单: 小满' }).querySelector('[data-single-thread-account-line]')
      ?.textContent

  const ENFORCED = { enforced: true, resetsAt: '2026-11-08T16:00:00+00:00', unlimited: false, usedRatio: 0.25 }
  const SHADOW = { ...ENFORCED, enforced: false }

  // hc-1133: the plan's name and nothing else, however much is used and whatever is limited.
  it.each([
    ['used this month', ok({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18 }), 'PRO'],
    ['used this week', ok({ period: 'week', planCode: 'fast', planName: '快速', usedRatio: 0.18 }), 'PRO'],
    ['barely used', ok({ period: 'month', planCode: 'free', planName: '免费', usedRatio: 0.0004 }), 'FREE'],
    ['over the allowance', ok({ period: 'month', planCode: 'advanced', planName: '高级', usedRatio: 1.25 }), 'MAX'],
    ['unlimited', ok({ period: 'month', planCode: 'advanced', planName: '高级', usedRatio: null }), 'MAX'],
    [
      'a week that only records',
      ok({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18, weekly: SHADOW }),
      'PRO'
    ],
    [
      'a week really limited: its number stays on the menu’s card',
      ok({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18, weekly: ENFORCED }),
      'PRO'
    ],
    [
      'a plan this build does not list: the cloud’s name for it',
      ok({ period: 'month', planCode: 'plus', planName: '团队', usedRatio: 0.18 }),
      '团队'
    ],
    ['no line from the cloud: the email', ok(null), 'xiaoman@example.com']
  ])('%s', async (_label, planUsage, expected) => {
    stubBridge({ planUsage })
    renderSidebar()

    await waitFor(() => expect(accountLine()).toBe(expected))
    expect(screen.getByRole('button', { name: '打开账户菜单: 小满' }).textContent).not.toMatch(/%|本月|本周|用了/)
  })

  it('an older cloud that gives no code: the sign-in’s code names it, as on the menu’s card', async () => {
    $authState.set({ ...$authState.get(), account: { ...$authState.get().account, plan: 'fast' } })
    stubBridge({ planUsage: ok({ period: 'month', planName: '快速', usedRatio: 0.18 }) })
    renderSidebar()

    await waitFor(() => expect(accountLine()).toBe('PRO'))
  })

  it('reads the line even when the app opens in the middle of a turn', async () => {
    threadState({ busy: true })
    stubBridge({ planUsage: ok({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18 }) })
    renderSidebar()

    await waitFor(() => expect(accountLine()).toBe('PRO'))
  })

  it('reads it again when a turn ends, not while one runs', async () => {
    const read = vi.fn(ok({ period: 'month', planCode: 'fast', planName: '快速', usedRatio: 0.18 }))
    stubBridge({ planUsage: read })
    renderSidebar()
    await waitFor(() => expect(accountLine()).toBe('PRO'))
    expect(read).toHaveBeenCalledTimes(1)

    act(() => threadState({ busy: true }))
    expect(read).toHaveBeenCalledTimes(1)

    act(() => threadState({ busy: false }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  })

  it('an older main process without the read shows the email', () => {
    renderSidebar()

    expect(accountLine()).toBe('xiaoman@example.com')
  })

  it('never shows one account’s usage for another', async () => {
    $planUsage.set({ accountId: 'acct-0', usage: { period: 'month', planName: '快速', usedRatio: 0.9 } })
    renderSidebar()

    expect(accountLine()).toBe('xiaoman@example.com')
  })

  it('an expired session gets AccountPanel’s sign-in card', () => {
    $authState.set({ ...$authState.get(), status: 'expired' })
    const { container } = renderSidebar()

    expect(container.querySelector('[data-single-thread-account]')).toBeNull()
    expect(screen.getByRole('button', { name: /登录已失效/ })).toBeTruthy()
  })
})

describe('hc-1133 the account menu is no longer AccountPanel’s twin', () => {
  async function menuItems(trigger: HTMLElement): Promise<string[]> {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    await screen.findByRole('menuitem', { name: '设置' })

    return screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
  }

  it('AccountPanel keeps its list; the single-thread row has the new one (account-menu.test.tsx pins it)', async () => {
    const panel = render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <AccountPanel businessChrome onNavigateBusiness={noop} />
        </I18nProvider>
      </MemoryRouter>
    )

    const panelItems = await menuItems(within(panel.container).getByRole('button', { name: '打开账户菜单: 小满' }))

    // Product mode reads 历史会话 as 更早的对话; the panel's list is otherwise what it always was.
    expect(panelItems).toEqual(['个人资料', '设置', '定时运行', '连接助手', '更早的对话', '重新登录', '退出登录'])

    cleanup()
    renderSidebar()

    const items = await menuItems(screen.getByRole('button', { name: '打开账户菜单: 小满' }))

    for (const moved of ['个人资料', '定时运行', '连接助手', '更早的对话', '重新登录']) {
      expect(items).not.toContain(moved)
    }

    expect(items).toContain('设置')
    expect(items).toContain('退出登录')
  })

  // hc-1121: AccountPanel stays mounted behind the login screen, so an open menu came back with the next sign-in.
  it.each([
    ['AccountPanel', () =>
      render(
        <MemoryRouter>
          <I18nProvider configClient={null} initialLocale="zh">
            <AccountPanel businessChrome onNavigateBusiness={noop} />
          </I18nProvider>
        </MemoryRouter>
      )],
    ['the single-thread row', () => renderSidebar()]
  ])('%s: signing out and back in leaves the menu closed', async (_name, mount) => {
    const signedIn = $authState.get()
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { signOut: async () => ({ ok: true }) } } })

    try {
      mount()
      await menuItems(screen.getByRole('button', { name: '打开账户菜单: 小满' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
      await waitFor(() => expect($authState.get().status).toBe('signed-out'))

      act(() => $authState.set(signedIn))

      await screen.findByRole('button', { name: '打开账户菜单: 小满' })
      expect(screen.queryByRole('menuitem', { name: '退出登录' })).toBeNull()
    } finally {
      // @ts-expect-error — remove the injected test bridge.
      delete window.hermesDesktop
    }
  })
})

describe('hc-1061 the voice panel is what says 通话中', () => {
  it('a call is open while the real panel is on screen', () => {
    const call = render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <VoiceConversationPanel level={0} muted={false} onEnd={noop} onToggleMute={noop} status="listening" />
        </I18nProvider>
      </MemoryRouter>
    )

    expect($threadInCall.get()).toBe(true)
    call.unmount()
    expect($threadInCall.get()).toBe(false)
  })
})
