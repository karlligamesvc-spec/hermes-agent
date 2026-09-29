import { useStore } from '@nanostores/react'
/**
 * Wiring surfaces — each pane is its own memoized component. Every surface
 * reads the reactive state it renders from at the leaf (its own atom
 * subscriptions) and reaches the controller's callbacks through the stable
 * `actions` bag, so a state change scoped to one surface (or a bare
 * wiring-controller tick) never re-renders another. This is what keeps the
 * layout tree's zones independently rendered — the whole point of the shell.
 */
import { type ComponentProps, lazy, memo, type ReactNode, Suspense, useEffect, useMemo, useRef } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { $authState } from '@/store/auth'
import { mainComposerScope, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeConnectionId } from '@/store/connections'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $freshDraftReady, $gatewayState, $selectedStoredSessionId } from '@/store/session'

import { AccountWorkspace } from '../account-workspace'
import { stageVideoAnalysisDraft } from '../business-workspace/video-analysis-composer-handoff'
import { ChatView } from '../chat'
import { ChatSidebar } from '../chat/sidebar'
import { RouteDrivenDrawer } from '../overlays/responsive-route-drawer'
import { TerminalPaneChrome } from '../right-sidebar/terminal/chrome'
import {
  ANALYSIS_ROUTE,
  ASSISTANT_ROUTE,
  contributedRoutes,
  deliverableIdForPath,
  DELIVERABLES_ROUTE,
  HISTORY_ROUTE,
  LEGACY_ACCOUNTS_ROUTE,
  NEW_CHAT_ROUTE,
  projectIdForPath,
  PROJECTS_ROUTE,
  routeDrawerBackgroundLocation,
  ROUTES_AREA,
  sessionRoute,
  workflowRunIdForPath,
  WORKFLOWS_ROUTE
} from '../routes'
import { useStatusSnapshot } from '../shell/hooks/use-status-snapshot'
import { useStatusbarItems } from '../shell/hooks/use-statusbar-items'
import { ModelMenuPanel } from '../shell/model-menu-panel'
import { ReasoningMenuPanel } from '../shell/reasoning-menu-panel'
import { StatusbarControls } from '../shell/statusbar-controls'

import { latestChatActions, latestSidebarActions } from './latest-actions'
import { setStatusbarItemGroup, useStatusbarContributions } from './panes'
import type { SidebarActions, WiringActions } from './types'

// Same lazy-view split as DesktopController — pages load on demand. The
// full-page views the workspace route table mounts live here; overlay views
// (agents/settings/…) are the controller's and stay in wiring.tsx.
const ArtifactsView = lazy(async () => ({ default: (await import('../artifacts')).ArtifactsView }))
const CronView = lazy(async () => ({ default: (await import('../cron')).CronView }))
const MessagingView = lazy(async () => ({ default: (await import('../messaging')).MessagingView }))
const SkillsView = lazy(async () => ({ default: (await import('../skills')).SkillsView }))
// ApexNodes full-page views — same lazy split, same workspace pane.
const ImEntryView = lazy(async () => ({ default: (await import('../im-entry')).ImEntryView }))
const AssistantWorkspaceView = lazy(async () => ({ default: (await import('../business-workspace/pages/assistant-page')).AssistantWorkspaceView }))
const TasksView = lazy(async () => ({ default: (await import('../tasks')).TasksView }))
// 搜索 is a page, not a sidebar field (see SEARCH_ROUTE).
const SearchView = lazy(async () => ({ default: (await import('../search')).SearchView }))
const ProjectsView = lazy(async () => ({ default: (await import('../business-workspace')).ProjectsView }))
const AnalysisView = lazy(async () => ({ default: (await import('../business-workspace/pages/analysis-page')).AnalysisView }))
const WorkflowsView = lazy(async () => ({ default: (await import('../business-workspace')).WorkflowsView }))
const DeliverablesView = lazy(async () => ({ default: (await import('../business-workspace')).DeliverablesView }))
const HistoryView = lazy(async () => ({ default: (await import('../business-workspace')).HistoryView }))

const DeliverableDetailView = lazy(async () => ({
  default: (await import('../business-workspace/pages/deliverable-detail-page')).DeliverableDetailView
}))

const ProjectDetailView = lazy(async () => ({
  default: (await import('../business-workspace/pages/project-detail-page')).ProjectDetailView
}))

const WorkflowRunView = lazy(async () => ({
  default: (await import('../business-workspace/pages/workflow-run-page')).WorkflowRunView
}))

export function LegacySessionRedirect() {
  const { sessionId } = useParams()

  return <Navigate replace to={sessionId ? sessionRoute(sessionId) : NEW_CHAT_ROUTE} />
}

function AnalysisRouteView({ actions }: { actions: WiringActions }) {
  const navigate = useNavigate()
  const mounted = useRef(true)
  const preparing = useRef(false)

  // This ref tracks component lifetime, never a mirrored atom value.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    mounted.current = true

    return () => { mounted.current = false }
  }, [])

  return <AnalysisView onDeepBreakdown={async (document, locale, frames) => {
    if ($connection.get()?.mode === 'remote' || preparing.current) {return}
    const previousSessionId = $selectedStoredSessionId.get()
    const gateway = $gateway.get()
    const connectionId = $activeConnectionId.get()
    const profile = $activeGatewayProfile.get()
    const auth = $authState.get()

    const isCurrent = () => mounted.current && $connection.get()?.mode !== 'remote' &&
      previousSessionId === $selectedStoredSessionId.get() && gateway === $gateway.get() &&
      connectionId === $activeConnectionId.get() && profile === $activeGatewayProfile.get() &&
      auth.status === $authState.get().status && auth.accountId === $authState.get().accountId && auth.account.email === $authState.get().account.email

    preparing.current = true

    try {
      const staged = await stageVideoAnalysisDraft(document, locale, frames, actions, isCurrent)

      if (!isCurrent()) { mainComposerScope.removeOccurrences(staged.attachments);

 return }

      if (previousSessionId) {
        const fresh = takeSessionDraft(null)

        stashSessionDraft(null, fresh.text, [
          ...fresh.attachments.filter(item => !item.analysisFrameSourceId && !item.analysisTranscriptSourceId),
          ...staged.attachments
        ])
        mainComposerScope.removeOccurrences(staged.attachments)
      }

      navigate(NEW_CHAT_ROUTE, { state: {
        businessGoalDraft: staged.draft, businessGoalFocus: true,
        analysisFrameHandoff: Boolean(previousSessionId),
        analysisTranscriptDraft: staged.transcript,
        analysisChatDraft: staged.workspaceDirectory ? { sourceId: document.id, scope: document.analysis_scope,
          revision: document.analysis_revision, directory: staged.workspaceDirectory, workspaceId: staged.workspaceId, locale,
          connectionId, profile: profile || 'default' } : undefined,
        analysisFrameDraft: { locale, sourceId: document.id, attemptedFrames: Math.min(3, frames.length), frames: staged.frames }
      } })
    } finally { preparing.current = false }
  }} />
}

export function LegacyAccountsRedirect() {
  const location = useLocation()

  return (
    <Navigate
      replace
      state={location.state}
      to={{ hash: location.hash, pathname: ASSISTANT_ROUTE, search: location.search }}
    />
  )
}

function WorkflowRunRouteDrawer() {
  const { t } = useI18n()

  return (
    <RouteDrivenDrawer compact deepLinkFallback={WORKFLOWS_ROUTE} title={t.businessWorkspace.workflowDomain.run.title}>
      <Suspense fallback={null}>
        <WorkflowRunView />
      </Suspense>
    </RouteDrivenDrawer>
  )
}

function ProjectDetailRouteDrawer() {
  const { t } = useI18n()

  return (
    <RouteDrivenDrawer deepLinkFallback={PROJECTS_ROUTE} title={t.businessWorkspace.projects.detailTitle}>
      <Suspense fallback={null}>
        <ProjectDetailView />
      </Suspense>
    </RouteDrivenDrawer>
  )
}

function DeliverableDetailRouteDrawer() {
  const { t } = useI18n()

  return (
    <RouteDrivenDrawer
      deepLinkFallback={DELIVERABLES_ROUTE}
      title={t.businessWorkspace.workflowDomain.deliverables.detailTitle}
    >
      <Suspense fallback={null}>
        <DeliverableDetailView />
      </Suspense>
    </RouteDrivenDrawer>
  )
}

export const SidebarSurface = memo(function SidebarSurface({
  actions,
  currentView
}: {
  actions: SidebarActions
  currentView: ComponentProps<typeof ChatSidebar>['currentView']
}) {
  const latestActions = useMemo(() => latestSidebarActions(actions), [actions])

  return <ChatSidebar currentView={currentView} {...latestActions} />
})

export const TerminalSurface = memo(function TerminalSurface() {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-terminal-surface-background)">
      <TerminalPaneChrome />
    </div>
  )
})

/** Owns the statusbar's own data hooks (status snapshot poll, contributed
 *  items) so its 15s refresh — and any statusbar-only churn — re-renders the
 *  bar alone, never the chat/sidebar/terminal. */
export const StatusbarSurface = memo(function StatusbarSurface({
  actions,
  agentsOpen,
  chatOpen,
  commandCenterOpen
}: {
  actions: WiringActions
  agentsOpen: boolean
  chatOpen: boolean
  commandCenterOpen: boolean
}) {
  const activeConnectionId = useStore($activeConnectionId)
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const gatewayState = useStore($gatewayState)
  const freshDraftReady = useStore($freshDraftReady)
  const gatewayScope = `${activeConnectionId ?? ''}\0${activeGatewayProfile}`
  const { inferenceStatus, statusSnapshot } = useStatusSnapshot(gatewayState, actions.requestGateway, gatewayScope)
  const extraLeftItems = useStatusbarContributions('left')
  const extraRightItems = useStatusbarContributions('right')

  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({
    agentsOpen,
    chatOpen,
    commandCenterOpen,
    extraLeftItems,
    extraRightItems,
    freshDraftReady,
    gatewayState,
    inferenceStatus,
    openAgents: actions.openAgents,
    openCommandCenterSection: actions.openCommandCenterSection,
    requestGateway: actions.requestGateway,
    statusSnapshot,
    toggleCommandCenter: actions.toggleCommandCenter
  })

  return <StatusbarControls items={statusbarItems} leftItems={leftStatusbarItems} />
})

/** The workspace pane: the real route table (chat + full-page views + plugin
 *  routes). Subscribes to the gateway instance/state and ROUTES_AREA itself;
 *  the voice cap arrives as a prop. ChatView subscribes to its own session
 *  atoms, so streaming never round-trips through the controller. */
export const ChatRoutesSurface = memo(function ChatRoutesSurface({
  actions,
  maxVoiceRecordingSeconds
}: {
  actions: WiringActions
  maxVoiceRecordingSeconds?: number
}) {
  const activeConnectionId = useStore($activeConnectionId)
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const gateway = useStore($gateway)
  const gatewayState = useStore($gatewayState)
  const location = useLocation()
  useContributions(ROUTES_AREA)
  const routeContributions = contributedRoutes()
  const workflowRunOpen = workflowRunIdForPath(location.pathname) !== null
  const projectDetailOpen = projectIdForPath(location.pathname) !== null
  const deliverableDetailOpen = deliverableIdForPath(location.pathname) !== null
  const objectRouteOpen = workflowRunOpen || projectDetailOpen || deliverableDetailOpen
  const backgroundLocation = objectRouteOpen ? routeDrawerBackgroundLocation(location.state) : null

  const pageLocation = objectRouteOpen
    ? (backgroundLocation ?? {
        hash: '',
        pathname: projectDetailOpen ? PROJECTS_ROUTE : deliverableDetailOpen ? DELIVERABLES_ROUTE : WORKFLOWS_ROUTE,
        search: '',
        state: null
      })
    : location

  const modelMenuContent = useMemo(
    () =>
      gatewayState === 'open' ? (
        <ModelMenuPanel
          gateway={gateway || undefined}
          onSelectModel={actions.selectModel}
          ownerConnectionId={activeConnectionId || undefined}
          profile={activeGatewayProfile}
          requestGateway={actions.requestGateway}
        />
      ) : null,
    [actions, activeConnectionId, activeGatewayProfile, gateway, gatewayState]
  )

  const reasoningMenuContent = useMemo(
    () =>
      gatewayState === 'open' ? (
        <ReasoningMenuPanel
          gateway={gateway || undefined}
          onSelectModel={actions.selectModel}
          ownerConnectionId={activeConnectionId || undefined}
          profile={activeGatewayProfile}
          requestGateway={actions.requestGateway}
        />
      ) : null,
    [actions, activeConnectionId, activeGatewayProfile, gateway, gatewayState]
  )

  const chatActions = useMemo(() => latestChatActions(actions), [actions])

  const chatView = (
    <ChatView
      gateway={gateway}
      maxVoiceRecordingSeconds={maxVoiceRecordingSeconds}
      modelMenuContent={modelMenuContent}
      objectRouteOpen={objectRouteOpen}
      {...chatActions}
    />
  )

  // FULL-PAGE views (not chat): a page is not a tab-able surface, so the zone's
  // tab strip stands down while one is showing. That is `paneChrome.headerVeto`
  // on the contribution, not a DOM marker — the `data-zone-no-header` attribute
  // that used to ride this wrapper gated a body double-click toggle that no
  // longer exists, and nothing has read it since.
  const page = (view: ReactNode) => (
    <div className="contents">
      <Suspense fallback={null}>{view}</Suspense>
    </div>
  )

  return (
    <>
      <Routes location={pageLocation}>
        <Route element={chatView} index />
        <Route element={chatView} path=":sessionId" />
        <Route element={page(<SkillsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="skills" />
        <Route element={page(<MessagingView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="messaging" />
        <Route element={page(<ArtifactsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="artifacts" />
        <Route element={page(<AccountWorkspace><DeliverablesView /></AccountWorkspace>)} path={DELIVERABLES_ROUTE.slice(1)} />
        <Route
          element={page(
            <CronView onOpenSession={actions.onResumeSession} setStatusbarItemGroup={setStatusbarItemGroup} />
          )}
          path="cron"
        />
        {/* hc-417 IM 入口 — scan-to-bind this machine's assistant to 飞书/微信/…
            Reached from the composer "+" menu's connectors row, the sidebar's
            channel strip, and Settings → 提供方. */}
        <Route element={page(<ImEntryView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="im-entry" />
        <Route element={page(<AccountWorkspace><AssistantWorkspaceView /></AccountWorkspace>)} path={ASSISTANT_ROUTE.slice(1)} />
        <Route element={<LegacyAccountsRedirect />} path={LEGACY_ACCOUNTS_ROUTE.slice(1)} />
        <Route
          element={page(
            <TasksView onOpenSession={actions.onResumeSession} setStatusbarItemGroup={setStatusbarItemGroup} />
          )}
          path="tasks"
        />
        <Route element={page(<SearchView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="search" />
        <Route element={page(<AccountWorkspace><HistoryView /></AccountWorkspace>)} path={HISTORY_ROUTE.slice(1)} />
        <Route element={page(<AccountWorkspace><ProjectsView /></AccountWorkspace>)} path="projects" />
        <Route element={page(<AccountWorkspace><AnalysisRouteView actions={actions} /></AccountWorkspace>)} path={ANALYSIS_ROUTE.slice(1)} />
        <Route element={page(<AccountWorkspace><WorkflowsView /></AccountWorkspace>)} path="workflows" />
        <Route element={null} path="agents" />
        <Route element={null} path="profile" />
        <Route element={null} path="command-center" />
        <Route element={null} path="profiles" />
        <Route element={null} path="settings" />
        <Route element={null} path="starmap" />
        <Route element={null} path="webhooks" />
        {/* Registry-contributed pages (core features + plugins) render in the
            workspace pane like any built-in view — behind the same blast wall
            as every other contribution mount. */}
        {routeContributions.map(route => (
          <Route
            element={page(
              <ContribBoundary id={route.key}>
                <ContribRender render={route.render} />
              </ContribBoundary>
            )}
            key={route.key}
            path={route.path.slice(1)}
          />
        ))}
        <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="new" />
        <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
        <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
      </Routes>

      {workflowRunOpen && (
        <Routes>
          <Route element={<AccountWorkspace><WorkflowRunRouteDrawer /></AccountWorkspace>} path="workflow-runs/:runId" />
        </Routes>
      )}
      {projectDetailOpen && (
        <Routes>
          <Route element={<AccountWorkspace><ProjectDetailRouteDrawer /></AccountWorkspace>} path="projects/:projectId" />
        </Routes>
      )}
      {deliverableDetailOpen && (
        <Routes>
          <Route element={<AccountWorkspace><DeliverableDetailRouteDrawer /></AccountWorkspace>} path="deliverables/:deliverableId" />
        </Routes>
      )}
    </>
  )
})
