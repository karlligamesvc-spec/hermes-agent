/**
 * hc-1078 (multi-bot M2) wired into hc-1077's sidebar, through the real SidebarSurface with several
 * assistants on: the 「+」 opens the new-assistant sheet (and says so at the limit), the 「···」 sits on
 * the assistant on screen only, and each change reads the roster again; a new assistant is opened,
 * and deleting the one on screen goes back to APEX. The engine calls themselves are
 * store/single-thread-bot-ops.test.ts's.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { createBot, deleteBot, readBotMeta, saveBotLook } from '@/store/single-thread-bot-ops'
import {
  $botRoster,
  $multiBotMax,
  type BotProfileRow,
  botRosterFrom,
  MULTI_BOT_MAX_DEFAULT,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { resetThreadPresenceForTest } from '@/store/single-thread-presence'
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
  saveBotLook: vi.fn()
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

const WRITER = { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' }

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  row('writer', WRITER),
  row('scripts', { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' })
]

/** What `profiles.list` answers now; a create or delete changes it. */
let listed: BotProfileRow[]
let root: HTMLElement

function renderSidebar() {
  const rendered = render(
    <MemoryRouter initialEntries={['/apex-root']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={ACTIONS} currentView="chat" />
        </SidebarProvider>
      </I18nProvider>
    </MemoryRouter>
  )

  root = rendered.container

  return rendered
}

const brandButtons = () =>
  [...root.querySelectorAll('[data-apex-sidebar-brand] button')].map(button => button.getAttribute('aria-label'))

const menuButtons = () =>
  [...root.querySelectorAll('[data-single-thread-bot-more]')].map(button => [
    button
      .closest('[data-single-thread-bot-frame]')
      ?.querySelector('[data-single-thread-bot]')
      ?.getAttribute('data-single-thread-bot'),
    button.getAttribute('aria-label')
  ])

async function chooseFromMenu(item: string) {
  const trigger = root.querySelector('[data-single-thread-bot-more]')!

  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }))
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetMainThreadForTest()
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
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { imEntry: { list: vi.fn(async () => ({ channels: [] })) }, managed: {} }
  })
  listed = ROWS
  requestOnApex.mockImplementation(async (method: string) =>
    method === 'profiles.list' ? { profiles: listed } : method === 'profiles.describe' ? { soul: 'You are X.\n' } : {}
  )
  ensureGatewayProfile.mockReset()
  ensureGatewayProfile.mockResolvedValue(undefined)
  vi.mocked(readBotMeta).mockResolvedValue({ meta: WRITER, revision: 2 })
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
  requestOnApex.mockReset()
  vi.mocked(createBot).mockReset()
  vi.mocked(deleteBot).mockReset()
  vi.mocked(readBotMeta).mockReset()
  vi.mocked(saveBotLook).mockReset()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('hc-1078 in the multi-bot sidebar', () => {
  it('「+」 opens the new-assistant sheet', async () => {
    renderSidebar()

    expect(brandButtons()).toEqual(['新建一个助手', '搜索'])
    fireEvent.click(screen.getByRole('button', { name: '新建一个助手' }))

    expect(await screen.findByRole('heading', { name: '新建一个助手' })).toBeTruthy()
    expect(screen.getByRole('dialog').querySelector('[data-bot-sheet-left]')?.textContent).toBe(
      '你已经建了 2 个，还能再建 2 个'
    )
  })

  it('a sheet left open goes with the sidebar: the next sidebar starts closed', async () => {
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: '新建一个助手' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()

    cleanup()
    renderSidebar()

    expect(screen.queryByRole('dialog')).toBeNull()
    // Nothing hides the sidebar from screen readers either (an open dialog would).
    expect(screen.getByRole('button', { name: '新建一个助手' })).toBeTruthy()
  })

  it('at the limit 「+」 says to delete one first, and the sheet cannot create', async () => {
    $multiBotMax.set(3)
    renderSidebar()

    const plus = screen.getByRole('button', { name: '已经有 3 个助手了，先删掉一个再建' })

    expect(plus.getAttribute('data-single-thread-new-bot')).toBe('full')
    fireEvent.click(plus)
    fireEvent.change(await screen.findByLabelText('叫它什么'), { target: { value: '剪辑助手' } })

    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '建好了' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('puts the 「···」 on the assistant on screen only', async () => {
    renderSidebar()

    expect(menuButtons()).toEqual([['default', '管理APEX']])

    cleanup()
    $activeGatewayProfile.set('writer')
    renderSidebar()

    await waitFor(() => expect(menuButtons()).toEqual([['writer', '管理小红书文案']]))
  })

  it('reads a new assistant into the roster and opens it', async () => {
    vi.mocked(createBot).mockImplementation(async () => {
      listed = [...ROWS, row('apex-bot-4', { color: 'teal', created: 3, name: '剪辑助手', shape: 'cloud' })]

      return 'apex-bot-4'
    })
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: '新建一个助手' }))
    fireEvent.change(await screen.findByLabelText('叫它什么'), { target: { value: '剪辑助手' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '建好了' }))

    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledWith('apex-bot-4'))
    expect(createBot).toHaveBeenCalledWith({ color: 'blue', name: '剪辑助手', shape: 'squircle' }, { count: 3, max: 5 })
    expect($botRoster.get().map(bot => bot.name)).toEqual(['APEX', '小红书文案', '带货脚本', '剪辑助手'])
    expect(requestOnApex).toHaveBeenCalledWith('profiles.list', {})
  })

  it('edits the assistant on screen, with every other name taken', async () => {
    $activeGatewayProfile.set('writer')
    vi.mocked(saveBotLook).mockResolvedValue(undefined)
    renderSidebar()

    await waitFor(() => expect(menuButtons()).toEqual([['writer', '管理小红书文案']]))
    await chooseFromMenu('改名或换样子')

    expect(await screen.findByRole('heading', { name: '改一下小红书文案' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('叫它什么'), { target: { value: '带货脚本' } })
    expect(screen.getByText('已经有助手叫这个名字了')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('叫它什么'), { target: { value: '小红书标题' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '改好了' }))

    await waitFor(() =>
      expect(saveBotLook).toHaveBeenCalledWith(
        'writer',
        { color: 'rose', name: '小红书标题', shape: 'squircle' },
        { revision: 2, stored: WRITER }
      )
    )
    await waitFor(() => expect(requestOnApex).toHaveBeenCalledWith('profiles.list', {}))
  })

  it('deleting the assistant on screen goes back to APEX', async () => {
    $activeGatewayProfile.set('writer')
    vi.mocked(deleteBot).mockImplementation(async () => {
      listed = ROWS.filter(candidate => candidate.name !== 'writer')
    })
    renderSidebar()

    await waitFor(() => expect(menuButtons()).toEqual([['writer', '管理小红书文案']]))
    await chooseFromMenu('删除这个助手')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删掉' }))

    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledWith('default'))
    expect(deleteBot).toHaveBeenCalledWith('writer')
    await waitFor(() => expect($botRoster.get().map(bot => bot.name)).toEqual(['APEX', '带货脚本']))
  })
})
