import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ComponentProps } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { $composerAttachments, clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'

import { routeDrawerNavigationState } from '../routes'

import { ChatRoutesSurface } from './surfaces'
import type { WiringActions } from './types'

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
vi.mock('../artifacts', () => ({ ArtifactsView: () => <div>artifacts-view</div> }))
vi.mock('../cron', () => ({ CronView: () => <div>cron-view</div> }))
vi.mock('../im-entry', () => ({ ImEntryView: () => <div>assistant-view</div> }))
vi.mock('../messaging', () => ({ MessagingView: () => <div>messaging-view</div> }))
vi.mock('../search', () => ({ SearchView: () => <div>search-view</div> }))
vi.mock('../skills', () => ({ SkillsView: () => <div>skills-view</div> }))
vi.mock('../tasks', () => ({ TasksView: () => <div>tasks-view</div> }))
vi.mock('../business-workspace', () => ({
  DeliverablesView: () => <div>deliverables-view</div>,
  HistoryView: () => <div>history-view</div>,
  ProjectsView: () => <div>projects-view</div>,
  WorkflowsView: () => <div>workflows-view</div>
}))
vi.mock('../business-workspace/pages/deliverable-detail-page', () => ({
  DeliverableDetailView: () => <div>deliverable-detail-view</div>
}))
vi.mock('../business-workspace/pages/workflow-run-page', () => ({
  WorkflowRunView: () => <div>workflow-run-view</div>
}))
vi.mock('../business-workspace/pages/analysis-page', () => ({
  AnalysisView: ({ onDeepBreakdown }: {
    onDeepBreakdown: (document: unknown, locale: 'en', frames: Array<{ seconds: number; dataUrl: string }>) => Promise<void>
  }) => <button onClick={() => void onDeepBreakdown({
    id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
    status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
    anchors: [{ id: 'a1', location: { start_seconds: 3, end_seconds: 5 }, text: 'verified speech' }],
    notes: [], questions: []
  }, 'en', [{ seconds: 12.5, dataUrl: `data:image/jpeg;base64,${btoa('frame')}` }])} type="button">Prepare video</button>
}))

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
      <output data-testid="goal-draft">{(location.state as { businessGoalDraft?: string } | null)?.businessGoalDraft ?? ''}</output>
      <output data-testid="frame-handoff">{JSON.stringify((location.state as { analysisFrameDraft?: unknown } | null)?.analysisFrameDraft ?? null)}</output>
      <button onClick={() => navigate(1)} type="button">
        Forward
      </button>
      <button onClick={() => navigate('/analysis')} type="button">Analysis</button>
    </>
  )
}

function renderRoutes(initialEntries: ComponentProps<typeof MemoryRouter>['initialEntries'], suppliedActions?: Partial<WiringActions>) {
  const actions = { getGateway: () => $gateway.get(), ...suppliedActions } as unknown as WiringActions

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
  $composerAttachments.set([])
  $selectedStoredSessionId.set(null)
  clearSessionDraft(null)
})

describe('ChatRoutesSurface', () => {
  it('adds a captured frame to the local composer before opening the reviewable Agent draft', async () => {
    let sequence = 0
    const onAttachImageBlob = vi.fn(async (_blob: Blob) => {
      sequence += 1
      $composerAttachments.set([...$composerAttachments.get(), {
        id: `image:${sequence}`, occurrenceId: `frame-${sequence}`, kind: 'image', label: `frame-${sequence}.jpg`
      }])

      return true
    })

    renderRoutes(['/analysis'], { onAttachImageBlob })
    expect(await screen.findByRole('button', { name: 'Prepare video' })).toBeTruthy()
    expect(onAttachImageBlob).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Prepare video' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(onAttachImageBlob).toHaveBeenCalledOnce()
    expect(onAttachImageBlob.mock.calls[0][0]).toBeInstanceOf(File)
    expect(screen.getByTestId('goal-draft').textContent).toContain('Attached frames')
    expect(screen.getByTestId('goal-draft').textContent).toContain('0:12.5')
    expect(screen.getByTestId('goal-draft').textContent).toContain('[0:03–0:05] "verified speech"')
    expect(JSON.parse(screen.getByTestId('frame-handoff').textContent ?? '')).toEqual({
      locale: 'en', sourceId: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptedFrames: 1,
      frames: [{ id: 'image:1', occurrenceId: 'frame-1', seconds: 12.5 }]
    })
    expect($composerAttachments.get()).toHaveLength(1)
    expect($composerAttachments.get()[0]?.analysisFrameSourceId).toBe('local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare video' }))
    await waitFor(() => expect(onAttachImageBlob).toHaveBeenCalledTimes(2))
    expect($composerAttachments.get()).toHaveLength(1)
    expect($composerAttachments.get()[0]?.occurrenceId).toBe('frame-2')
  })

  it('moves accepted frames into the new draft when a prior chat is selected', async () => {
    $selectedStoredSessionId.set('previous-chat')
    $composerAttachments.set([{ id: 'user-image', occurrenceId: 'user-1', kind: 'image', label: 'own.jpg' }])
    stashSessionDraft(null, 'existing fresh text', [
      { id: 'old-frame', occurrenceId: 'old-1', kind: 'image', label: 'old.jpg', analysisFrameSourceId: 'old-source' }
    ])
    const onAttachImageBlob = vi.fn(async (_blob: Blob) => {
      $composerAttachments.set([...$composerAttachments.get(), {
        id: 'new-frame', occurrenceId: 'new-1', kind: 'image', label: 'new.jpg'
      }])

      return true
    })

    renderRoutes(['/analysis'], { onAttachImageBlob })
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare video' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect($composerAttachments.get().map(item => item.id)).toEqual(['user-image'])
    expect(takeSessionDraft(null)).toMatchObject({
      text: 'existing fresh text',
      attachments: [{ id: 'new-frame', analysisFrameSourceId: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]
    })
    expect(screen.getByTestId('goal-draft').textContent).toContain('Attached frames')
  })

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

  it('keeps Deliverables below a Deliverable drawer and gives cold deep links the canonical fallback', async () => {
    const source = { hash: '#reports', pathname: '/deliverables', search: '?kind=report' }

    renderRoutes([
      source,
      {
        pathname: '/deliverables/deliverable-831',
        state: routeDrawerNavigationState(source, 'deliverable:deliverable-831')
      }
    ])

    expect(await screen.findByText('deliverables-view')).toBeTruthy()
    expect(await screen.findByText('deliverable-detail-view')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Deliverable details' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Deliverable details' })).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/deliverables?kind=report#reports')

    cleanup()
    renderRoutes(['/deliverables/deliverable-831'])
    expect(await screen.findByText('deliverables-view')).toBeTruthy()
    fireEvent.keyDown(globalThis.document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Deliverable details' })).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/deliverables')
  })
})
