/**
 * hc-1077 多助手第一期 M1 (prototype v2 ⑥ Bots, ⑨ BotSwitch): the single-thread
 * sidebar with several assistants on, rendered through the real SidebarSurface.
 * With the switch off it is hc-1061's sidebar byte for byte
 * (src/multi-bot-identity.test.tsx).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import type { AppView } from '@/app/routes'
import { SingleThreadBotRows } from '@/app/single-thread/sidebar-bots'
import type { ClientSessionState } from '@/app/types'
import { apexBotColorHex } from '@/components/apex-avatar-look'
import { SidebarProvider } from '@/components/ui/sidebar'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { $authState } from '@/store/auth'
import {
  $mainThreadsByProfile,
  MAIN_THREAD_TITLE,
  noteMainThreadClaimed,
  resetMainThreadForTest
} from '@/store/main-thread'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botCreateRequest,
  $botLastSessions,
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { $botSeenReplyIds, resetThreadPresenceForTest } from '@/store/single-thread-presence'
import { $threadActivity } from '@/store/thread-signals'
import { setToolViewMode } from '@/store/tool-view'
import { remixRunningTurn } from '@/test/remix-turn'

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined)
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

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

let root: HTMLElement

function renderSidebar(view: AppView = 'chat') {
  const rendered = render(
    <MemoryRouter initialEntries={['/apex-root']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={ACTIONS} currentView={view} />
        </SidebarProvider>
      </I18nProvider>
    </MemoryRouter>
  )

  root = rendered.container

  return rendered
}

const row = (name: string, apex: Record<string, unknown>): BotProfileRow => ({ name, ui_meta: { apex } })

const ROWS: BotProfileRow[] = [
  row('scripts', { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' }),
  { is_default: true, name: 'default' },
  row('writer', { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' })
]

const reply = (id: string, text: string): ChatMessage => ({ id, parts: [{ text, type: 'text' }], role: 'assistant' })

function session(storedSessionId: string, extra: Partial<ClientSessionState>): ClientSessionState {
  return { busy: false, messages: [], needsInput: false, storedSessionId, ...extra } as unknown as ClientSessionState
}

function threads(byProfile: Record<string, string>) {
  $mainThreadsByProfile.set(
    Object.fromEntries(
      Object.entries(byProfile).map(([profile, id]) => [
        profile,
        { ids: [id], profile, rootId: id, status: 'found' as const, tipId: id }
      ])
    )
  )
}

const rowFor = (profile: string) => root.querySelector<HTMLElement>(`[data-single-thread-bot="${profile}"]`)!
const lineOf = (profile: string) => rowFor(profile).querySelector('[data-single-thread-status]')?.textContent ?? null
const dotOn = (profile: string) => Boolean(rowFor(profile).querySelector('[role="img"]'))

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetMainThreadForTest()
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  $activeGatewayProfile.set('default')
  noteMainThreadClaimed('default', 'apex-root')
  $selectedStoredSessionId.set('apex-root')
  $authState.set({
    account: { email: 'xiaoman@example.com', name: '小满', plan: '' },
    accountId: 'acct-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { imEntry: { list: vi.fn(async () => ({ channels: [] })) }, managed: {} }
  })
  ensureGatewayProfile.mockReset()
  ensureGatewayProfile.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
  resetThreadPresenceForTest()
  resetBotRosterForTest()
  $sessionStates.set({})
  $selectedStoredSessionId.set(null)
  $notifications.set([])
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('hc-1077 the rows', () => {
  it('APEX first, then the assistants in the order they were made; 「+」 sits before search', async () => {
    const { container } = renderSidebar()

    await waitFor(() => expect(container.querySelector('[data-single-thread-wechat="unbound"]')).not.toBeNull())

    expect(
      [...container.querySelectorAll('[data-single-thread-nav="thread"]')].map(node => [
        node.getAttribute('data-single-thread-bot'),
        node.querySelector('.truncate')?.textContent
      ])
    ).toEqual([
      ['default', 'APEX'],
      ['writer', '小红书文案'],
      ['scripts', '带货脚本']
    ])

    const brand = container.querySelector('[data-apex-sidebar-brand]')!

    expect([...brand.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual([
      '新建一个助手',
      '搜索'
    ])
    expect(
      rowFor('scripts').compareDocumentPosition(container.querySelector('[data-single-thread-wechat]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('each wears its own face: APEX the purple circle, the others their shape and colour', () => {
    renderSidebar()

    const face = (profile: string) => {
      const svg = rowFor(profile).querySelector('svg[data-apex-avatar]')!
      const body = svg.querySelector('circle, path')!

      return [body.tagName, body.getAttribute('fill')]
    }

    expect(face('default')).toEqual(['circle', '#6A4CEB'])
    expect(face('writer')).toEqual(['path', apexBotColorHex('rose')])
    expect(face('scripts')).toEqual(['path', apexBotColorHex('orange')])
  })

  it('the assistant on screen is the active row; the others are not', () => {
    renderSidebar()

    expect(rowFor('default').className).toContain('bg-(--ui-row-active-background)')
    expect(rowFor('default').getAttribute('aria-current')).toBe('true')
    expect(rowFor('writer').className).not.toContain('bg-(--ui-row-active-background)')
    expect(rowFor('writer').getAttribute('aria-current')).toBeNull()
  })

  it('「+」 asks for the new-assistant sheet', () => {
    renderSidebar()

    const before = $botCreateRequest.get()

    fireEvent.click(screen.getByRole('button', { name: '新建一个助手' }))
    expect($botCreateRequest.get()).toBe(before + 1)
  })

  it('「在微信里找」 names APEX by its name now, whichever assistant is on screen (K7)', async () => {
    resetBotRosterForTest(
      botRosterFrom([{ is_default: true, name: 'default', ui_meta: { apex: { name: '小A' } } }], () => true)
    )
    $activeGatewayProfile.set('writer')
    renderSidebar()

    expect(await screen.findByText('在微信里找 小A')).toBeTruthy()
  })
})

describe('hc-1077 each row follows its own assistant', () => {
  it('the one on screen reads the activity line; one in the background folds its own turn', () => {
    threads({ default: 'apex-root', writer: 'writer-root' })
    $sessionStates.set({
      apex: session('apex-root', { busy: true }),
      writer: session('writer-root', {
        busy: true,
        messages: remixRunningTurn().map(message => ({
          id: message.id,
          parts: message.content as ChatMessage['parts'],
          role: message.role
        }))
      })
    })
    $threadActivity.set({ text: '正在剪辑… 第 2 步', waiting: false })
    renderSidebar()

    expect(lineOf('default')).toBe('正在剪辑… 第 2 步')
    expect(lineOf('writer')).toBe('正在识别语音…')
    expect(rowFor('writer').getAttribute('data-state')).toBe('working')
    expect(rowFor('writer').querySelector('[data-apex-avatar]')?.getAttribute('data-apex-avatar')).toBe('working')
    expect(lineOf('scripts')).toBeNull()
  })

  it('等你决定 for a background assistant waiting on a question', () => {
    threads({ writer: 'writer-root' })
    $sessionStates.set({ writer: session('writer-root', { busy: true, needsInput: true }) })
    renderSidebar()

    expect(lineOf('writer')).toBe('等你决定')
  })

  it('one never opened here: its last line, only when that newest conversation is its thread', () => {
    threads({ scripts: 'scripts-root', writer: 'writer-root' })
    $botLastSessions.set({
      scripts: { id: 'scripts-root', preview: '**好，定稿了。**下次换款直接丢链接' },
      writer: { id: 'some-other-chat', preview: '这条不是主线' }
    })
    renderSidebar()

    expect(lineOf('scripts')).toBe('好，定稿了。下次换款直接丢链接')
    expect(lineOf('writer')).toBeNull()
  })

  it('a dot when a background assistant replies after the user last had it open', async () => {
    threads({ writer: 'writer-root' })
    $sessionStates.set({ writer: session('writer-root', { messages: [reply('w-1', '标题写好了 3 个')] }) })
    $botSeenReplyIds.set({ writer: 'w-1' })
    renderSidebar()

    expect(dotOn('writer')).toBe(false)

    act(() => {
      $sessionStates.set({
        writer: session('writer-root', { messages: [reply('w-1', '标题写好了 3 个'), reply('w-2', '又加了 2 个')] })
      })
    })

    expect(dotOn('writer')).toBe(true)
    expect(within(rowFor('writer')).getByRole('img', { name: '有新消息' })).toBeTruthy()
  })

  it('the row on screen paints without a dot, even before it marks its reply seen', () => {
    threads({ default: 'apex-root' })
    $sessionStates.set({ apex: session('apex-root', { messages: [reply('a-2', '好了')] }) })
    $botSeenReplyIds.set({ default: 'a-1' })

    // A server render runs no effect: this is the first paint, before markBotReplySeen.
    const html = renderToStaticMarkup(
      <I18nProvider configClient={null} initialLocale="zh">
        <SingleThreadBotRows onOpenCurrent={noop} viewing />
      </I18nProvider>
    )

    expect(html).toContain('data-single-thread-bot="default"')
    expect(html).not.toContain('有新消息')
    expect($botSeenReplyIds.get().default).toBe('a-1')
  })

  it('no dot for one the user never opened, nor for the one on screen', () => {
    threads({ default: 'apex-root', writer: 'writer-root' })
    $sessionStates.set({
      apex: session('apex-root', { messages: [reply('a-2', '好了')] }),
      writer: session('writer-root', { messages: [reply('w-1', '标题写好了')] })
    })
    $botSeenReplyIds.set({ default: 'a-1' })
    renderSidebar()

    expect(dotOn('default')).toBe(false)
    expect(dotOn('writer')).toBe(false)
    // Being on screen marks it seen.
    expect($botSeenReplyIds.get().default).toBe('a-2')
  })
})

describe('hc-1077 switching', () => {
  it('a click on another assistant activates its engine and takes the row at once', async () => {
    let settle!: () => void

    ensureGatewayProfile.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (settle = () => resolve(undefined)))
    )
    renderSidebar()

    fireEvent.click(rowFor('writer'))

    expect(ensureGatewayProfile).toHaveBeenCalledWith('writer')
    expect(rowFor('writer').getAttribute('aria-current')).toBe('true')
    expect(rowFor('default').getAttribute('aria-current')).toBeNull()

    await act(async () => {
      $activeGatewayProfile.set('writer')
      settle()
    })

    expect(rowFor('writer').getAttribute('aria-current')).toBe('true')
  })

  it('says so in words when the assistant cannot be opened, offers a retry, and stays on the one on screen', async () => {
    ensureGatewayProfile.mockRejectedValueOnce(new Error('spawn failed: Traceback (most recent call last)'))
    renderSidebar()

    fireEvent.click(rowFor('scripts'))

    await waitFor(() => expect($notifications.get()).toHaveLength(1))

    const [notice] = $notifications.get()

    expect([notice!.kind, notice!.message, notice!.action?.label]).toEqual([
      'error',
      '暂时打不开「带货脚本」，稍后再试。',
      '重试'
    ])
    expect(JSON.stringify(notice)).not.toMatch(/spawn|Traceback/)
    expect(rowFor('default').getAttribute('aria-current')).toBe('true')

    act(() => notice!.action!.onClick())

    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledTimes(2))
    expect(ensureGatewayProfile).toHaveBeenLastCalledWith('scripts')
  })

  it('every pooled engine busy (hc-1080): names who is working, by name, not the code', async () => {
    ensureGatewayProfile.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'hermes:connection': Error: APEX_POOL_ALL_BUSY " +
          '{"busy":["writer","default","editor"],"limit":3}'
      )
    )
    renderSidebar()

    fireEvent.click(rowFor('scripts'))

    await waitFor(() => expect($notifications.get()).toHaveLength(1))

    const [notice] = $notifications.get()

    expect([notice!.kind, notice!.message, notice!.action?.label]).toEqual([
      'warning',
      '小红书文案、APEX、editor都在做事，等其中一个做完再切过来。',
      '重试'
    ])
    expect(JSON.stringify(notice)).not.toContain('APEX_POOL_ALL_BUSY')
  })

  it('a click on the assistant on screen goes back to its conversation without a switch', () => {
    renderSidebar('settings')

    fireEvent.click(rowFor('default'))

    expect(ensureGatewayProfile).not.toHaveBeenCalled()
  })

  it('the thread title stays the identity key whatever the assistant is called', () => {
    expect(MAIN_THREAD_TITLE).toBe('APEX 主线')
  })
})
