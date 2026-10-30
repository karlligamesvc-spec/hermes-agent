import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { type ComponentProps, useState } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { $authState } from '@/store/auth'
import { $composerAttachments, clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { useVoiceLiveConversation } from '../chat/composer/hooks/use-voice-live-conversation'
import { VoiceConversationPanel } from '../chat/composer/voice-conversation-panel'
import { OverlayView } from '../overlays/overlay-view'
import { routeDrawerNavigationState } from '../routes'

import { ChatRoutesSurface } from './surfaces'
import type { WiringActions } from './types'

const nativeCall = vi.hoisted(() => ({
  constructed: vi.fn(), start: vi.fn(async () => undefined), close: vi.fn(),
  think: vi.fn(), speak: vi.fn(), setMuted: vi.fn(), instruct: vi.fn()
}))

vi.mock('@/lib/qwen-realtime', () => ({
  QwenRealtimeSession: vi.fn(function () {
    nativeCall.constructed()

    return nativeCall
  })
}))

const originalBridge = window.hermesDesktop

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
  ChatView: ({ gateway }: { gateway: { id?: string } | null }) => {
    const [active, setActive] = useState(false)

    const call = useVoiceLiveConversation({
      enabled: active, busy: false, onSubmit: vi.fn(), pendingResponse: () => null,
      consumePendingResponse: vi.fn(), seedHistory: () => []
    })

    return <>
      <div data-testid="gateway">{gateway?.id}</div>
      <button onClick={() => setActive(true)} type="button">Start fixture call</button>
      {active && <VoiceConversationPanel {...call} onEnd={() => { call.end(); setActive(false) }} onToggleMute={call.toggleMute} />}
    </>
  }
}))
vi.mock('../chat/sidebar', () => ({ ChatSidebar: () => null }))
vi.mock('../single-thread/sidebar', () => ({ SingleThreadSidebar: () => null }))
vi.mock('../single-thread/use-single-thread-shell', () => ({ useSingleThreadShell: () => undefined }))
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
vi.mock('../business-workspace/pages/project-detail-page', () => ({
  ProjectDetailView: () => <div>project-detail-view</div>
}))
vi.mock('../business-workspace/pages/analysis-page', () => ({
  AnalysisView: ({ onDeepBreakdown }: {
    onDeepBreakdown: (document: unknown, locale: 'en', frames: Array<{ seconds: number; dataUrl: string }>) => Promise<void>
  }) => <button onClick={() => void onDeepBreakdown({
    id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
    status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
    analysis_scope: 'owner', analysis_revision: 'current',
    anchors: [{ id: 'a1', location: { start_seconds: 3, end_seconds: 5 }, text: 'verified speech' }],
    notes: [], questions: []
  }, 'en', [{ seconds: 12.5, dataUrl: `data:image/jpeg;base64,${btoa('frame')}` }]).catch(() => undefined)} type="button">Prepare video</button>
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
      {['/', '/chat-1', '/analysis', '/projects', '/cron', '/workflows', '/history', '/deliverables', '/tasks', '/skills', '/messaging', '/artifacts', '/im-entry', '/assistant', '/search', '/settings', '/projects/project-1', '/workflow-runs/run-1', '/deliverables/item-1'].map(path => <button key={path} onClick={() => navigate(path)} type="button">Go {path}</button>)}
    </>
  )
}

const originalAuth = $authState.get()

function SettingsRouteFixture() {
  const location = useLocation()
  const navigate = useNavigate()

  return location.pathname === '/settings'
    ? <OverlayView onClose={() => navigate('/chat-1')} title="Fixture settings"><p>Settings content</p></OverlayView>
    : null
}

function renderRoutes(initialEntries: ComponentProps<typeof MemoryRouter>['initialEntries'], suppliedActions?: Partial<WiringActions>) {
  $authState.set({ ...originalAuth, enabled: true, status: 'signed-in', accountId: 'owner', account: { email: 'route@fixture.test', name: 'Route fixture', plan: '' } })
  const actions = { getGateway: () => $gateway.get(), ...suppliedActions } as unknown as WiringActions

  return render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={(initialEntries?.length ?? 1) - 1}>
      <I18nProvider configClient={null} initialLocale="en">
        <LocationProbe />
        <ChatRoutesSurface actions={actions} />
        <SettingsRouteFixture />
      </I18nProvider>
    </MemoryRouter>
  )
}

afterEach(async () => {
  cleanup()
  // Radix restores focus in a zero-delay teardown task; finish it in this DOM realm.
  await new Promise(resolve => setTimeout(resolve, 0))
  $authState.set(originalAuth)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
  $gateway.set(null)
  $activeGatewayProfile.set('default')
  $composerAttachments.set([])
  $selectedStoredSessionId.set(null)
  clearSessionDraft(null)
  vi.clearAllMocks()
})

describe('ChatRoutesSurface', () => {
  it('menu navigation retains one native call and its moved panel, including interactive settings and drawers', async () => {
    renderRoutes(['/chat-1'])
    fireEvent.click(screen.getByRole('button', { name: 'Start fixture call' }))
    await waitFor(() => expect(nativeCall.start).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(screen.getByRole('group', { name: 'Move voice window' }), { key: 'ArrowRight' })
    const movedStyle = screen.getByRole('region', { name: 'Start voice conversation' }).getAttribute('style')
    expect(screen.getByRole('button', { name: 'Live transcript' }).getAttribute('aria-expanded')).toBe('true')

    for (const path of ['/analysis', '/projects', '/cron', '/workflows', '/history', '/deliverables', '/tasks', '/skills', '/messaging', '/artifacts', '/im-entry', '/assistant', '/search', '/projects/project-1', '/workflow-runs/run-1', '/deliverables/item-1', '/', '/chat-1']) {
      // Drawers trap focus too; return via the router instead of an inaccessible background button.
      if (screen.queryByRole('dialog')) {
        fireEvent.click(screen.getByRole('button', { name: /Close/ }))
      }

      fireEvent.click(await screen.findByRole('button', { name: `Go ${path}` }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'End voice conversation' })).toBeTruthy())
      expect(screen.getByRole('region', { name: 'Start voice conversation' }).getAttribute('style')).toBe(movedStyle)
      expect(screen.getByRole('button', { name: 'Live transcript' }).getAttribute('aria-expanded')).toBe('true')
      expect(nativeCall.constructed).toHaveBeenCalledTimes(1)
      expect(nativeCall.close).not.toHaveBeenCalled()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Go /settings' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Fixture settings' }).contains(screen.getByRole('button', { name: 'Mute microphone' }))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }))
    expect(nativeCall.setMuted).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'End voice conversation' }))
    expect(nativeCall.close).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: 'Start voice conversation' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

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
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: {
      analysisDocuments: { transcriptForDraft: vi.fn().mockResolvedValue({ ok: true, text: 'complete transcript' }) },
      savePastedText: vi.fn().mockResolvedValue('/local/transcript.txt')
    } })
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
      attachments: [
        { kind: 'file', path: '/local/transcript.txt', analysisTranscriptSourceId: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { id: 'new-frame', analysisFrameSourceId: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
      ]
    })
    expect(screen.getByTestId('goal-draft').textContent).toContain('Attached frames')
  })

  it('does not route or attach a late transcript after a profile switch', async () => {
    let finish!: (path: string) => void
    const savePastedText = vi.fn(() => new Promise<string>(resolve => {finish = resolve}))
    const transcriptForDraft = vi.fn().mockResolvedValue({ ok: true, text: 'owned transcript' })
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: {
      analysisDocuments: { transcriptForDraft }, savePastedText
    } })
    $composerAttachments.set([{ id: 'user-file', occurrenceId: 'user-1', kind: 'file', label: 'own.txt' }])
    renderRoutes(['/analysis'], { onAttachImageBlob: vi.fn() })
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare video' }))
    await waitFor(() => expect(savePastedText).toHaveBeenCalledOnce())
    await act(async () => { $activeGatewayProfile.set('other-profile'); finish('/late/transcript.txt') })
    expect(screen.getByTestId('location').textContent).toBe('/analysis')
    expect($composerAttachments.get().map(item => item.id)).toEqual(['user-file'])
    expect(transcriptForDraft).toHaveBeenCalledOnce()
    expect(screen.getByTestId('goal-draft').textContent).toBe('')
  })

  it('passes the live gateway after an open-to-open profile switch', () => {
    const gatewayA = { id: 'a' } as unknown as HermesGateway
    const gatewayB = { id: 'b' } as unknown as HermesGateway

    $gateway.set(gatewayA)
    const actions = { getGateway: () => $gateway.get() } as unknown as WiringActions

    render(
      <MemoryRouter>
        <ChatRoutesSurface actions={actions} />
        <SettingsRouteFixture />
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

describe('hc-1070 single-thread product mode has no 沉浸式分析', () => {
  const analysisOnScreen = () => screen.queryByRole('button', { name: 'Prepare video' })

  afterEach(() => {
    setSingleThreadFlagForTest(false)
    setToolViewMode('product')
  })

  it('a cold start on /analysis (a remembered route, a deep link at launch) lands on the conversation', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/analysis'])

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(analysisOnScreen()).toBeNull()
  })

  it('navigating there later (hermes://open, a plugin notification, host.navigate) turns back too', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/chat-1'])

    fireEvent.click(screen.getByRole('button', { name: 'Go /analysis' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(analysisOnScreen()).toBeNull()
  })

  it('turns back before the sign-in gate: a signed-out window does not sit on a blank analysis page', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/chat-1'])
    act(() => $authState.set({ ...$authState.get(), status: 'signed-out' }))

    fireEvent.click(screen.getByRole('button', { name: 'Go /analysis' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
  })

  it('closes the page that is open when developer mode is switched off', async () => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('technical')
    renderRoutes(['/analysis'])
    expect(await screen.findByRole('button', { name: 'Prepare video' })).toBeTruthy()

    act(() => setToolViewMode('product'))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(analysisOnScreen()).toBeNull()
  })

  it.each([
    ['the switch off', false, 'product'],
    ['developer mode with the switch on', true, 'technical']
  ] as const)('%s keeps the workspace on /analysis', async (_label, flag, toolView) => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
    renderRoutes(['/analysis'])

    expect(await screen.findByRole('button', { name: 'Prepare video' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/analysis')
  })
})

describe('hc-1123 single-thread product mode has no 项目', () => {
  const projectsOnScreen = () => screen.queryByText('projects-view') ?? screen.queryByText('project-detail-view')
  const where = () => screen.getByTestId('location').textContent

  const openedFrom = (pathname: string, to: string) => ({
    pathname: to,
    state: routeDrawerNavigationState({ hash: '', pathname, search: '', state: null })
  })

  afterEach(() => {
    setSingleThreadFlagForTest(false)
    setToolViewMode('product')
  })

  it.each(['/projects', '/projects?status=active#row', '/projects/', '/PROJECTS', '/projects/project-1', '/projects/project%2Fa%20b', '/projects/a/b'])(
    'a cold start on %s lands on the conversation',
    async path => {
      setSingleThreadFlagForTest(true)
      renderRoutes([path])

      await waitFor(() => expect(where()).toBe('/'))
      expect(projectsOnScreen()).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    }
  )

  it.each(['/projects', '/projects/project-1'])(
    'navigating to %s later (hermes://open, a plugin notification, host.navigate) turns back too',
    async path => {
      setSingleThreadFlagForTest(true)
      renderRoutes(['/chat-1'])

      fireEvent.click(screen.getByRole('button', { name: `Go ${path}` }))

      await waitFor(() => expect(where()).toBe('/'))
      expect(projectsOnScreen()).toBeNull()
    }
  )

  it('history forward onto a project page turns back', async () => {
    setSingleThreadFlagForTest(true)
    render(
      <MemoryRouter initialEntries={['/chat-1', '/projects']} initialIndex={0}>
        <I18nProvider configClient={null} initialLocale="en">
          <LocationProbe />
          <ChatRoutesSurface actions={{ getGateway: () => null } as unknown as WiringActions} />
        </I18nProvider>
      </MemoryRouter>
    )
    expect(where()).toBe('/chat-1')

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))

    await waitFor(() => expect(where()).toBe('/'))
    expect(projectsOnScreen()).toBeNull()
  })

  it('a project drawer over a page that stays closes itself, and takes nobody back to a project on close', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/deliverables', openedFrom('/deliverables', '/projects/project-1')])

    await waitFor(() => expect(where()).toBe('/'))
    expect(projectsOnScreen()).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a deliverable opened from a project page before the switch does not put the project page under it', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/projects', openedFrom('/projects', '/deliverables/item-1')])

    await waitFor(() => expect(where()).toBe('/'))
    expect(projectsOnScreen()).toBeNull()
  })

  it.each(['/projects', '/projects/project-1'])(
    'turns back from %s before the sign-in gate: a signed-out window does not sit on a blank page',
    async path => {
      setSingleThreadFlagForTest(true)
      renderRoutes(['/chat-1'])
      act(() => $authState.set({ ...$authState.get(), status: 'signed-out' }))

      fireEvent.click(screen.getByRole('button', { name: `Go ${path}` }))

      await waitFor(() => expect(where()).toBe('/'))
    }
  )

  it('turns a signed-out project drawer over a page that stays back too: its own gate, not the page under it', async () => {
    setSingleThreadFlagForTest(true)
    $authState.set({ ...originalAuth, enabled: true, status: 'signed-out' })
    render(
      <MemoryRouter initialEntries={['/deliverables', openedFrom('/deliverables', '/projects/project-1')]} initialIndex={1}>
        <I18nProvider configClient={null} initialLocale="en">
          <LocationProbe />
          <ChatRoutesSurface actions={{ getGateway: () => null } as unknown as WiringActions} />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(where()).toBe('/'))
  })

  it.each(['/projects', '/projects/project-1'])('closes %s when developer mode is switched off', async path => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('technical')
    renderRoutes([path])
    expect(await screen.findByText(path === '/projects' ? 'projects-view' : 'project-detail-view')).toBeTruthy()

    act(() => setToolViewMode('product'))

    await waitFor(() => expect(where()).toBe('/'))
    expect(projectsOnScreen()).toBeNull()
  })

  it.each(['/projects', '/projects/project-1'])(
    'closes %s when the switch is read after a remembered route has already opened it',
    async path => {
      setSingleThreadFlagForTest(false)
      renderRoutes([path])
      expect(await screen.findByText(path === '/projects' ? 'projects-view' : 'project-detail-view')).toBeTruthy()

      act(() => setSingleThreadFlagForTest(true))

      await waitFor(() => expect(where()).toBe('/'))
      expect(projectsOnScreen()).toBeNull()
    }
  )

  it.each([
    ['/cron', 'cron-view'],
    ['/deliverables', 'deliverables-view'],
    ['/history', 'history-view'],
    ['/assistant', 'assistant-view'],
    ['/workflows', 'workflows-view'],
    ['/deliverables/item-1', 'deliverable-detail-view'],
    ['/workflow-runs/run-1', 'workflow-run-view']
  ])('keeps %s', async (path, view) => {
    setSingleThreadFlagForTest(true)
    renderRoutes([path])

    expect(await screen.findByText(view)).toBeTruthy()
    expect(where()).toBe(path)
  })

  it.each(['/settings', '/profile'])('keeps %s open as an overlay route', async path => {
    setSingleThreadFlagForTest(true)
    renderRoutes([path])
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(where()).toBe(path)
  })

  it('a deliverable opened directly closes onto 交付物, never onto a project page', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/deliverables/item-1'])
    await screen.findByText('deliverable-detail-view')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(where()).toBe('/deliverables'))
    expect(screen.getByText('deliverables-view')).toBeTruthy()
  })

  it('a run opened from 连接助手 keeps 连接助手 under it and closes back onto it', async () => {
    setSingleThreadFlagForTest(true)
    renderRoutes(['/assistant', openedFrom('/assistant', '/workflow-runs/run-1')])
    await screen.findByText('workflow-run-view')
    expect(screen.getByText('assistant-view')).toBeTruthy()
    expect(screen.queryByText('workflows-view')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(where()).toBe('/assistant'))
  })

  it.each([
    ['the switch off', false, 'product'],
    ['developer mode with the switch on', true, 'technical']
  ] as const)('%s keeps both project routes', async (_label, flag, toolView) => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
    renderRoutes(['/projects'])

    expect(await screen.findByText('projects-view')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go /projects/project-1' }))
    expect(await screen.findByText('project-detail-view')).toBeTruthy()
    expect(where()).toBe('/projects/project-1')
  })
})
