/**
 * hc-1014 identity guard harness. Renders the surfaces single-thread mode
 * changes — the sidebar, the account menu, a transcript spanning two days, the
 * history page — exactly the way the goldens beside this file were recorded on
 * fork main 4ee99a81d6, before any single-thread code existed. It must keep
 * using only APIs that main already had: the same file recorded the goldens
 * there.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'

import { HistoryView } from '@/app/business-workspace/pages/history-page'
import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import type { AppView } from '@/app/routes'
import { ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { SidebarProvider } from '@/components/ui/sidebar'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $selectedStoredSessionId, $sessions, $sessionsLoading } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'

/** Long past, so the sidebar's date buckets and the history page's dates never move with the clock. */
const PAST = new Date(2026, 4, 1, 9, 0).getTime() / 1000

export const SESSION_ROWS = [
  makeSessionInfo({
    id: 'chat-a',
    last_active: PAST + 600,
    message_count: 4,
    profile: 'default',
    started_at: PAST,
    title: '选题：换季收纳'
  }),
  makeSessionInfo({
    id: 'chat-b',
    last_active: PAST + 300,
    message_count: 2,
    profile: 'default',
    started_at: PAST,
    title: '脚本：9.9 元好物'
  })
]

/** React's, Radix's and dnd-kit's generated ids count up per render in one test run; they are not what the guard is about. */
export function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+|Dnd(?:DescribedBy|LiveRegion)-\d+/g, '«id»')
}

/** The clock every golden was recorded at: relative ages ("5 天") must not drift with the real date. */
export const GOLDEN_NOW = new Date(2026, 9, 21, 12, 0)

export function seedShellState(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(GOLDEN_NOW)
  setRuntimeI18nLocale('zh')
  $sessions.set(SESSION_ROWS)
  $sessionsLoading.set(false)
  $selectedStoredSessionId.set('chat-a')
  $authState.set({
    account: { email: 'kael@example.com', name: 'Kael', plan: '' },
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
}

const noop = () => {}

const SIDEBAR_ACTIONS: SidebarActions = {
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

export function renderSidebar(pathname = '/chat-a', view: AppView = 'chat', onNavigate = SIDEBAR_ACTIONS.onNavigate) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={{ ...SIDEBAR_ACTIONS, onNavigate }} currentView={view} />
        </SidebarProvider>
      </I18nProvider>
    </MemoryRouter>
  )
}

/** The account menu's item names, in order. */
export async function accountMenuItems(): Promise<string[]> {
  render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="zh">
        <AccountPanel />
      </I18nProvider>
    </MemoryRouter>
  )

  fireEvent.pointerDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { button: 0, ctrlKey: false })
  await screen.findByRole('menuitem', { name: '设置' })

  return screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
}

const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute)

function turn(id: string, createdAt: Date, ask: string, answer: string): ThreadMessage[] {
  return [
    {
      attachments: [],
      content: [{ text: ask, type: 'text' }],
      createdAt,
      id: `${id}-ask`,
      metadata: { custom: {} },
      role: 'user'
    } as ThreadMessage,
    {
      content: [{ text: answer, type: 'text' }],
      createdAt: new Date(createdAt.getTime() + 30_000),
      id: `${id}-answer`,
      metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' }
    } as unknown as ThreadMessage
  ]
}

/** One thread over two days: a morning turn, one after 7 idle hours, one the next morning. */
export const TWO_DAY_TRANSCRIPT: ThreadMessage[] = [
  ...turn('t1', at(5, 1, 9), '帮我想 3 个换季收纳的选题', '1. 衣柜多出一半空间 2. 不打孔 3. 9.9 元'),
  ...turn('t2', at(5, 1, 16, 30), '第 2 个写成 30 秒脚本', '好，开头一句结论，再拍前后对比。'),
  ...turn('t3', at(5, 2, 9), '昨天那条发了，播放 1.2 万', '不错，完播多少？我帮你看哪里掉人。')
]

export async function renderTranscript(messages: ThreadMessage[], onBranchInNewChat?: (id: string) => void) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread onBranchInNewChat={onBranchInNewChat} />
      </ThreadRuntime>
    </I18nProvider>
  )

  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  return view.container
}

/** Every turn of the transcript, in order — dividers included, since they would sit inside these rows. */
export function transcriptHtml(container: HTMLElement): string {
  return normalized(
    [...container.querySelectorAll('[data-slot="aui_message-group"]')].map(node => node.outerHTML).join('\n')
  )
}

export function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api: vi.fn(async () => new Promise(() => undefined)) }
  })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/history']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <HistoryView />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
