/**
 * hc-1146: Grok Bot's row menu on the multi-bot sidebar, through the real SidebarSurface and the
 * app's own right-click handler (AppContextMenu): a right-click on any assistant row opens the row
 * menu — 置顶 · 标为未读 | 改名 | 复制对话 ID | 从侧栏隐藏 · 删除 — instead of the window menu, the
 * 「···」 opens the same one, and each item does what it says. The `ui_meta.apex` write itself is
 * store/single-thread-bot-ops.test.ts's; the order rule is store/single-thread-bots.test.ts's.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppContextMenu } from '@/app/context-menu/app-context-menu'
import { $contextMenu } from '@/app/context-menu/store'
import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import { SidebarProvider } from '@/components/ui/sidebar'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { deleteBot, readBotMeta, saveBotSidebarFlags } from '@/store/single-thread-bot-ops'
import {
  $multiBotMax,
  type BotProfileRow,
  botRosterFrom,
  MULTI_BOT_MAX_DEFAULT,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { $botUnreadMarks, resetThreadPresenceForTest } from '@/store/single-thread-presence'
import { setToolViewMode } from '@/store/tool-view'

const { ensureGatewayProfile, requestOnApex } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined),
  requestOnApex: vi.fn()
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

vi.mock('@/store/single-thread-bot-ops', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  createBot: vi.fn(),
  deleteBot: vi.fn(),
  readBotMeta: vi.fn(),
  requestOnApex,
  saveBotLook: vi.fn(),
  saveBotSidebarFlags: vi.fn()
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

const row = (name: string, apex: Record<string, unknown>): BotProfileRow => ({ name, ui_meta: { apex } })

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  row('writer', { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' }),
  row('scripts', { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' })
]

const NAMED_MENU = ['置顶', '标为未读', '改名或换样子', '复制对话 ID', '从侧栏隐藏', '删除这个助手']

/** What `profiles.list` answers now; a saved flag changes it. */
let listed: BotProfileRow[]
let root: HTMLElement
let writeClipboard: ReturnType<typeof vi.fn>

function renderSidebar() {
  const rendered = render(
    <MemoryRouter initialEntries={['/apex-root']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={ACTIONS} currentView="chat" />
        </SidebarProvider>
        <AppContextMenu />
      </I18nProvider>
    </MemoryRouter>
  )

  root = rendered.container

  return rendered
}

const rowOf = (profile: string) => root.querySelector<HTMLElement>(`[data-single-thread-bot="${profile}"]`)

const rowOrder = () =>
  [...root.querySelectorAll('[data-single-thread-bot]')].map(el => el.getAttribute('data-single-thread-bot'))

const menuItems = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map(item => item.textContent)

async function rightClick(profile: string) {
  fireEvent.contextMenu(rowOf(profile)!, { button: 2, clientX: 40, clientY: 80 })

  return screen.findByRole('menu')
}

async function choose(profile: string, item: string) {
  fireEvent.click(within(await rightClick(profile)).getByRole('menuitem', { name: item }))
}

/** A saved flag lands in what the next roster read answers, as profile.yaml would. */
function saveIntoListing() {
  vi.mocked(saveBotSidebarFlags).mockImplementation(async (profile, flags) => {
    listed = listed.map(entry =>
      entry.name === profile ? { ...entry, ui_meta: { apex: { ...(entry.ui_meta?.apex as object), ...flags } } } : entry
    )
  })
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetMainThreadForTest()
  resetThreadPresenceForTest()
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  $multiBotMax.set(MULTI_BOT_MAX_DEFAULT)
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
  writeClipboard = vi.fn(async () => undefined)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { imEntry: { list: vi.fn(async () => ({ channels: [] })) }, managed: {}, writeClipboard }
  })
  listed = ROWS
  requestOnApex.mockImplementation(async (method: string) =>
    method === 'profiles.list' ? { profiles: listed } : method === 'profiles.describe' ? { soul: 'You are X.\n' } : {}
  )
  ensureGatewayProfile.mockReset()
  ensureGatewayProfile.mockResolvedValue(undefined)
  saveIntoListing()
})

afterEach(() => {
  cleanup()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
  resetThreadPresenceForTest()
  resetBotRosterForTest()
  $multiBotMax.set(MULTI_BOT_MAX_DEFAULT)
  $selectedStoredSessionId.set(null)
  $notifications.set([])
  $contextMenu.set(null)
  requestOnApex.mockReset()
  vi.mocked(deleteBot).mockReset()
  vi.mocked(readBotMeta).mockReset()
  vi.mocked(saveBotSidebarFlags).mockReset()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('hc-1146 the row menu', () => {
  it('opens on a right-click on any assistant row, in Grok’s groups, and the window menu stays shut', async () => {
    renderSidebar()

    const menu = await rightClick('scripts')

    expect(menuItems(menu)).toEqual(NAMED_MENU)
    // Lines between 置顶·标为未读 | 改名 | 复制对话 ID | 从侧栏隐藏·删除.
    expect(within(menu).getAllByRole('separator')).toHaveLength(3)
    expect(within(menu).getByRole('menuitem', { name: '删除这个助手' }).getAttribute('data-variant')).toBe(
      'destructive'
    )
    expect($contextMenu.get()).toBeNull()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })

  it('gives APEX — on screen, under its 「···」 frame — only what applies to it', async () => {
    renderSidebar()

    const menu = await rightClick('default')

    expect(menuItems(menu)).toEqual(['标为未读', '改名', '复制对话 ID'])
    expect(within(menu).getAllByRole('separator')).toHaveLength(2)
    expect($contextMenu.get()).toBeNull()
  })

  it('the 「···」 opens the very same menu', async () => {
    $activeGatewayProfile.set('writer')
    renderSidebar()

    const more = root.querySelector('[data-single-thread-bot-more]')!

    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(menuItems(await screen.findByRole('menu'))).toEqual(NAMED_MENU)
  })

  it('置顶 moves the assistant right after APEX with a pin, and 取消置顶 puts it back', async () => {
    renderSidebar()
    expect(rowOrder()).toEqual(['default', 'writer', 'scripts'])

    await choose('scripts', '置顶')

    expect(saveBotSidebarFlags).toHaveBeenCalledWith('scripts', { pinned: true })
    expect(rowOrder()).toEqual(['default', 'scripts', 'writer'])
    await waitFor(() => expect(requestOnApex).toHaveBeenCalledWith('profiles.list', {}))
    expect(rowOf('scripts')!.querySelector('[data-single-thread-bot-pinned]')?.getAttribute('aria-label')).toBe(
      '已置顶'
    )
    expect(rowOf('writer')!.querySelector('[data-single-thread-bot-pinned]')).toBeNull()

    await choose('scripts', '取消置顶')

    expect(saveBotSidebarFlags).toHaveBeenLastCalledWith('scripts', { pinned: false })
    expect(rowOrder()).toEqual(['default', 'writer', 'scripts'])
  })

  it('a pin that did not save goes back where it was and says so', async () => {
    vi.mocked(saveBotSidebarFlags).mockRejectedValue(new Error('engine down'))
    renderSidebar()

    await choose('scripts', '置顶')

    await waitFor(() => expect(rowOrder()).toEqual(['default', 'writer', 'scripts']))
    expect($notifications.get().map(note => note.message)).toContain('没改成，再试一次。')
  })

  it('从侧栏隐藏 takes the row out into 「已隐藏」, and picking it there puts it back', async () => {
    renderSidebar()

    await choose('writer', '从侧栏隐藏')

    expect(saveBotSidebarFlags).toHaveBeenCalledWith('writer', { hidden: true })
    expect(rowOrder()).toEqual(['default', 'scripts'])
    const hiddenRow = root.querySelector<HTMLElement>('[data-single-thread-hidden-bots]')!
    expect(hiddenRow.textContent).toContain('已隐藏 1 个助手')
    await waitFor(() =>
      expect($notifications.get().map(note => note.message)).toContain(
        '已隐藏「小红书文案」，在助手下面的「已隐藏」里能找回'
      )
    )

    fireEvent.pointerDown(hiddenRow, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('点一下放回侧栏')).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: '小红书文案' }))

    expect(saveBotSidebarFlags).toHaveBeenLastCalledWith('writer', { hidden: false })
    expect(rowOrder()).toEqual(['default', 'writer', 'scripts'])
    expect(root.querySelector('[data-single-thread-hidden-bots]')).toBeNull()
  })

  it('hiding the assistant on screen goes back to APEX', async () => {
    $activeGatewayProfile.set('writer')
    renderSidebar()

    await choose('writer', '从侧栏隐藏')

    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledWith('default'))
  })

  it('标为未读 lights the dot until the conversation is next on screen; 标为已读 puts it out', async () => {
    renderSidebar()
    expect(rowOf('writer')!.querySelector('[aria-label="有新消息"]')).toBeNull()

    await choose('writer', '标为未读')

    expect(rowOf('writer')!.querySelector('[aria-label="有新消息"]')).not.toBeNull()
    expect($botUnreadMarks.get()).toEqual(['writer'])
    expect(JSON.parse(window.localStorage.getItem('apex.single-thread.bots.unread-marks.v1') ?? 'null')).toEqual([
      'writer'
    ])

    await choose('writer', '标为已读')

    expect(rowOf('writer')!.querySelector('[aria-label="有新消息"]')).toBeNull()
    expect($botUnreadMarks.get()).toEqual([])
  })

  it('a marked assistant’s dot goes once its conversation is on screen', async () => {
    renderSidebar()
    await choose('writer', '标为未读')
    cleanup()

    noteMainThreadClaimed('writer', 'writer-root')
    $activeGatewayProfile.set('writer')
    $selectedStoredSessionId.set('writer-root')
    renderSidebar()

    await waitFor(() => expect($botUnreadMarks.get()).toEqual([]))
    expect(rowOf('writer')!.querySelector('[aria-label="有新消息"]')).toBeNull()
  })

  it('复制对话 ID copies the live id of the assistant’s thread, and is off while it has none', async () => {
    renderSidebar()

    await choose('default', '复制对话 ID')

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('apex-root'))
    expect($notifications.get().map(note => note.message)).toContain('已复制对话 ID')

    const menu = await rightClick('scripts')

    expect(within(menu).getByRole('menuitem', { name: '复制对话 ID' }).hasAttribute('data-disabled')).toBe(true)
  })

  it('删除这个助手 from a right-click on a row not on screen asks first', async () => {
    renderSidebar()

    await choose('scripts', '删除这个助手')

    expect(await screen.findByRole('heading', { name: '删掉「带货脚本」？' })).toBeTruthy()
    expect(deleteBot).not.toHaveBeenCalled()
  })

  it('改名 from a right-click opens the sheet for that assistant', async () => {
    vi.mocked(readBotMeta).mockResolvedValue({ meta: { name: '带货脚本' }, revision: 1 })
    renderSidebar()

    await act(async () => choose('scripts', '改名或换样子'))

    expect(await screen.findByRole('heading', { name: '改一下带货脚本' })).toBeTruthy()
  })
})
