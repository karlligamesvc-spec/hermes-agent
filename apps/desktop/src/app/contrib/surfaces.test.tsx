import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ComponentProps } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import { routeDrawerNavigationState } from '../routes'

import { ChatRoutesSurface } from './surfaces'
import type { WiringActions } from './types'

vi.mock('@/contrib/react/use-contributions', () => ({ useContributions: vi.fn() }))
vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('local') }))
vi.mock('@/store/gateway', () => ({ $gateway: atom<unknown>(null) }))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('default') }))
vi.mock('@/store/session', () => ({
  $freshDraftReady: atom(false),
  $gatewayState: atom('open')
}))
vi.mock('../chat', () => ({
  ChatView: ({ gateway }: { gateway: { id?: string } | null }) => <div data-testid="gateway">{gateway?.id}</div>
}))
vi.mock('../chat/sidebar', () => ({ ChatSidebar: () => null }))
vi.mock('../right-sidebar/terminal/chrome', () => ({ TerminalPaneChrome: () => null }))
vi.mock('../shell/hooks/use-status-snapshot', () => ({ useStatusSnapshot: () => ({}) }))
vi.mock('../shell/hooks/use-statusbar-items', () => ({
  useStatusbarItems: () => ({ leftStatusbarItems: [], statusbarItems: [] })
}))
vi.mock('../shell/statusbar-controls', () => ({ StatusbarControls: () => null }))
vi.mock('../routes', async importOriginal => ({ ...(await importOriginal()), contributedRoutes: () => [] }))
vi.mock('./latest-actions', () => ({ latestChatActions: () => ({}), latestSidebarActions: () => ({}) }))
vi.mock('./panes', () => ({ setStatusbarItemGroup: vi.fn(), useStatusbarContributions: () => [] }))
vi.mock('../shell/model-menu-panel', () => ({ ModelMenuPanel: () => null }))
vi.mock('../artifacts', () => ({ ArtifactsView: () => <div>deliverables-view</div> }))
vi.mock('../cron', () => ({ CronView: () => <div>cron-view</div> }))
vi.mock('../im-entry', () => ({ ImEntryView: () => <div>assistant-view</div> }))
vi.mock('../messaging', () => ({ MessagingView: () => <div>messaging-view</div> }))
vi.mock('../search', () => ({ SearchView: () => <div>history-view</div> }))
vi.mock('../skills', () => ({ SkillsView: () => <div>skills-view</div> }))
vi.mock('../tasks', () => ({ TasksView: () => <div>tasks-view</div> }))
vi.mock('../business-workspace', () => ({
  ProjectsView: () => <div>projects-view</div>,
  WorkflowsView: () => <div>workflows-view</div>
}))
vi.mock('../business-workspace/pages/workflow-run-page', () => ({ WorkflowRunView: () => <div>workflow-run-view</div> }))

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
      <button onClick={() => navigate(1)} type="button">
        Forward
      </button>
    </>
  )
}

function renderRoutes(initialEntries: ComponentProps<typeof MemoryRouter>['initialEntries']) {
  const actions = { getGateway: () => $gateway.get() } as unknown as WiringActions

  return render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={(initialEntries?.length ?? 1) - 1}>
      <I18nProvider configClient={null} initialLocale="en">
        <LocationProbe />
        <ChatRoutesSurface actions={actions} />
      </I18nProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  $gateway.set(null)
  $activeGatewayProfile.set('default')
})

describe('ChatRoutesSurface', () => {
  it('passes the live gateway after an open-to-open profile switch', () => {
    const gatewayA = { id: 'a' } as unknown as HermesGateway
    const gatewayB = { id: 'b' } as unknown as HermesGateway

    $gateway.set(gatewayA)
    const actions = { getGateway: () => $gateway.get() } as unknown as WiringActions

    render(
      <MemoryRouter>
        <ChatRoutesSurface actions={actions} />
      </MemoryRouter>
    )

    expect(screen.getByTestId('gateway').textContent).toBe('a')

    act(() => {
      $gateway.set(gatewayB)
      $activeGatewayProfile.set('other')
    })

    expect(screen.getByTestId('gateway').textContent).toBe('b')
  })

  it.each([
    ['/deliverables', 'deliverables-view'],
    ['/assistant', 'assistant-view'],
    ['/history', 'history-view']
  ])('mounts the canonical %s page without changing its URL', async (path, marker) => {
    renderRoutes([path])

    expect(await screen.findByText(marker)).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe(path)
  })

  it('redirects the legacy accounts route to assistant while preserving query and hash', async () => {
    renderRoutes(['/accounts?channel=feishu#permissions'])

    expect(await screen.findByText('assistant-view')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/assistant?channel=feishu#permissions')
  })

  it('keeps the source page mounted below a workflow Run drawer and closes through browser history', async () => {
    const source = { hash: '#active', pathname: '/projects', search: '?status=running', state: { scrollTop: 320 } }

    renderRoutes([
      source,
      {
        pathname: '/workflow-runs/run-806',
        state: routeDrawerNavigationState(source)
      }
    ])

    expect(await screen.findByText('projects-view')).toBeTruthy()
    expect(await screen.findByText('workflow-run-view')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Workflow run' }).getAttribute('data-route-drawer')).not.toBeNull()
    expect(screen.getByTestId('location').textContent).toBe('/workflow-runs/run-806')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workflow run' })).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/projects?status=running#active')

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))

    expect(await screen.findByRole('dialog', { name: 'Workflow run' })).toBeTruthy()
    expect(screen.getByText('projects-view')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/workflow-runs/run-806')
  })

  it('backs a cold workflow Run deep link with Workflows and closes by replacing the deep link', async () => {
    renderRoutes(['/workflow-runs/run-806'])

    expect(await screen.findByText('workflows-view')).toBeTruthy()
    expect(await screen.findByText('workflow-run-view')).toBeTruthy()

    fireEvent.keyDown(globalThis.document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workflow run' })).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/workflows')
  })
})
