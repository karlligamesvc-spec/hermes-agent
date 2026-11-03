// First, before any app module: the zone the shell goldens are recorded in.
import './__identity__/single-thread-shell/time-zone'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatRoutesSurface } from '@/app/contrib/surfaces'
import type { WiringActions } from '@/app/contrib/types'
import { routeDrawerNavigationState } from '@/app/routes'
import { I18nProvider } from '@/i18n'
import { $authState } from '@/store/auth'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { seedSignedIn } from './__identity__/fold-projects/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1123 identity guard (hard rule 11): the route table, on the real
 * ChatRoutesSurface, with the switch off and in developer mode. The trace in
 * `__identity__/fold-projects/route-table.json` was recorded on fork main
 * 0055de7721 before any hc-1123 code existed. A diff means the off path moved:
 * fix the code; re-record only for a change meant to reach every user.
 */

vi.mock('@/contrib/react/use-contributions', () => ({ useContributions: vi.fn() }))
vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('local') }))
vi.mock('@/store/gateway', () => ({ $gateway: atom<unknown>(null) }))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('default') }))
vi.mock('@/store/session', () => ({
  $connection: atom({ mode: 'local' }),
  $freshDraftReady: atom(false),
  $gatewayState: atom('open'),
  $selectedStoredSessionId: atom<string | null>(null)
}))
vi.mock('@/app/chat', () => ({ ChatView: () => <div data-view="chat" /> }))
vi.mock('@/app/chat/sidebar', () => ({ ChatSidebar: () => null }))
vi.mock('@/app/single-thread/sidebar', () => ({ SingleThreadSidebar: () => null }))
vi.mock('@/app/single-thread/use-single-thread-shell', () => ({ useSingleThreadShell: () => undefined }))
vi.mock('@/app/right-sidebar/terminal/chrome', () => ({ TerminalPaneChrome: () => null }))
vi.mock('@/app/shell/hooks/use-status-snapshot', () => ({ useStatusSnapshot: () => ({}) }))
vi.mock('@/app/shell/hooks/use-statusbar-items', () => ({
  useStatusbarItems: () => ({ leftStatusbarItems: [], statusbarItems: [] })
}))
vi.mock('@/app/shell/statusbar-controls', () => ({ StatusbarControls: () => null }))
vi.mock('@/app/routes', async importOriginal => ({ ...(await importOriginal<object>()), contributedRoutes: () => [] }))
vi.mock('@/app/contrib/latest-actions', () => ({ latestChatActions: () => ({}), latestSidebarActions: () => ({}) }))
vi.mock('@/app/contrib/panes', () => ({ setStatusbarItemGroup: vi.fn(), useStatusbarContributions: () => [] }))
vi.mock('@/app/shell/model-menu-panel', () => ({ ModelMenuPanel: () => null }))
vi.mock('@/app/artifacts', () => ({ ArtifactsView: () => <div data-view="artifacts" /> }))
vi.mock('@/app/cron', () => ({ CronView: () => <div data-view="cron" /> }))
vi.mock('@/app/im-entry', () => ({ ImEntryView: () => <div data-view="im-entry" /> }))
vi.mock('@/app/messaging', () => ({ MessagingView: () => <div data-view="messaging" /> }))
vi.mock('@/app/search', () => ({ SearchView: () => <div data-view="search" /> }))
vi.mock('@/app/skills', () => ({ SkillsView: () => <div data-view="skills" /> }))
vi.mock('@/app/tasks', () => ({ TasksView: () => <div data-view="tasks" /> }))
vi.mock('@/app/business-workspace', () => ({
  DeliverablesView: () => <div data-view="deliverables" />,
  HistoryView: () => <div data-view="history" />,
  ProjectsView: () => <div data-view="projects" />,
  WorkflowsView: () => <div data-view="workflows" />
}))
vi.mock('@/app/business-workspace/pages/assistant-page', () => ({
  AssistantWorkspaceView: () => <div data-view="assistant" />
}))
vi.mock('@/app/business-workspace/pages/analysis-page', () => ({ AnalysisView: () => <div data-view="analysis" /> }))
vi.mock('@/app/business-workspace/pages/deliverable-detail-page', () => ({
  DeliverableDetailView: () => <div data-view="deliverable-detail" />
}))
vi.mock('@/app/business-workspace/pages/project-detail-page', () => ({
  ProjectDetailView: () => <div data-view="project-detail" />
}))
vi.mock('@/app/business-workspace/pages/workflow-run-page', () => ({
  WorkflowRunView: () => <div data-view="workflow-run" />
}))

const ROUTES = [
  '/',
  '/chat-1',
  '/new',
  '/sessions/session-1',
  '/analysis',
  '/projects',
  '/projects?status=active#row',
  '/projects/',
  '/projects/project-1',
  '/projects/project%2Fa%20b',
  '/projects/a/b',
  '/PROJECTS',
  '/workflows',
  '/workflows?projectId=project-1',
  '/workflow-runs/run-1',
  '/deliverables',
  '/deliverables/item-1',
  '/cron',
  '/history',
  '/assistant',
  '/accounts',
  '/tasks',
  '/skills',
  '/messaging',
  '/artifacts',
  '/im-entry',
  '/search',
  '/settings',
  '/profile',
  '/agents',
  '/not/a/route'
]

function background(pathname: string) {
  return routeDrawerNavigationState({ hash: '', pathname, search: '', state: null })
}

/** Object routes opened from a page keep that page underneath and go back to it on close. */
const OPENED_FROM = [
  { from: '/deliverables', to: '/projects/project-1' },
  { from: '/workflows', to: '/projects/project-1' },
  { from: '/assistant', to: '/workflow-runs/run-1' },
  { from: '/projects', to: '/deliverables/item-1' },
  { from: '/projects', to: '/workflow-runs/run-1' },
  { from: '/history', to: '/deliverables/item-1' }
]

function Where() {
  const location = useLocation()

  return <output data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</output>
}

async function settled() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

function renderAt(entries: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={(entries?.length ?? 1) - 1}>
      <I18nProvider configClient={null} initialLocale="zh">
        <Where />
        <ChatRoutesSurface actions={{ getGateway: () => null } as unknown as WiringActions} />
      </I18nProvider>
    </MemoryRouter>
  )
}

/** What the route resolved to: where the router ended up, the page views on screen, whether chat is the one showing. */
function snapshot() {
  const chat = document.querySelector('[data-view="chat"]')?.parentElement

  return {
    chatShown: chat?.className === 'contents',
    views: [...document.querySelectorAll('[data-view]')]
      .map(node => node.getAttribute('data-view'))
      .filter(view => view !== 'chat'),
    where: screen.getByTestId('where').textContent
  }
}

async function trace() {
  const out: Record<string, unknown> = {}

  for (const path of ROUTES) {
    renderAt([path])
    await settled()
    out[path] = snapshot()
    cleanup()
  }

  for (const { from, to } of OPENED_FROM) {
    renderAt([from, { pathname: to, state: background(from) }])
    await settled()
    const opened = snapshot()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await settled()
    out[`${to} from ${from}`] = { closed: snapshot(), opened }
    cleanup()
  }

  for (const to of ['/projects/project-1', '/workflow-runs/run-1', '/deliverables/item-1']) {
    renderAt([to])
    await settled()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await settled()
    out[`${to} closed, opened directly`] = snapshot()
    cleanup()
  }

  act(() => $authState.set({ ...$authState.get(), status: 'signed-out' }))

  for (const path of ['/projects', '/projects/project-1', '/workflows', '/assistant', '/deliverables']) {
    renderAt([path])
    await settled()
    out[`${path} signed out`] = snapshot()
    cleanup()
  }

  return out
}

beforeEach(() => {
  seedSignedIn()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

afterAll(restoreRecordingTimeZone)

describe.each([
  ['the switch off', false, 'product'],
  ['developer mode with the switch on', true, 'technical']
] as const)('hc-1123 %s: the route table is byte-identical to main', (_label, flag, toolView) => {
  it('resolves every route, drawer and sign-in state the way main does', async () => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)

    await expect(`${JSON.stringify(await trace(), null, 2)}\n`).toMatchFileSnapshot(
      './__identity__/fold-projects/route-table.json'
    )
  })
})
