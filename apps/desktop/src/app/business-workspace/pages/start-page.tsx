import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import type { ComposerAttachment } from '@/store/composer'
import { $connection } from '@/store/session'

import { routeDrawerNavigationState, workflowRunRoute, WORKFLOWS_ROUTE } from '../../routes'
import { listVideoWorkflowCatalog, startWorkflowGoal } from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'
import { BUSINESS_GOAL_INPUT_ID, BusinessGoalLauncher } from '../components/business-goal-launcher'
import { BusinessStartShelf } from '../components/start-shelf'
import { useVideoWorkflowCatalog } from '../hooks/use-workflow-domain-lists'
import type { BusinessHomeStarter, BusinessWorkflowStarter } from '../view-model/workflow-starters'
import { businessWorkflowStarters, videoWorkflowStarters } from '../view-model/workflow-starters'

export interface BusinessStartHomeProps {
  attachments?: ComposerAttachment[]
  goalDisabled?: boolean
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  onRemoveAttachment?: (id: string) => void
  onSubmitGoal?: (goal: string) => Promise<boolean> | boolean
}

/**
 * Prototype-aligned frame for the business Start route.
 *
 * The top action and starter shelf share one goal field. When the authenticated
 * workflow-domain bridge is available, submission creates the canonical
 * Project → Workflow → Run chain; older/dark shells retain the chat fallback.
 */
export function BusinessStartHome({
  attachments = [],
  goalDisabled = false,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSubmitGoal
}: BusinessStartHomeProps) {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const connection = useStore($connection)
  const videoCatalog = useVideoWorkflowCatalog()

  const workflows = useMemo(
    () => [
      ...businessWorkflowStarters(t.businessWorkspace.workflows),
      ...videoWorkflowStarters(t.businessWorkspace.workflows)
    ],
    [t]
  )

  const launchState = location.state as null | {
    businessGoalDraft?: unknown
    businessGoalFocus?: unknown
    businessProjectId?: unknown
    businessWorkflowCatalogProvenance?: unknown
    businessWorkflowId?: unknown
    businessWorkflowSlug?: unknown
    businessWorkflowVersion?: unknown
  }

  const launchedWorkflow = useMemo(() => {
    const routedWorkflow = workflows.find(workflow => workflow.slug === launchState?.businessWorkflowSlug) ?? null

    return routedWorkflow
      ? {
          ...routedWorkflow,
          id: typeof launchState?.businessWorkflowId === 'string' ? launchState.businessWorkflowId : routedWorkflow.id,
          version:
            typeof launchState?.businessWorkflowVersion === 'number' &&
            Number.isSafeInteger(launchState.businessWorkflowVersion) &&
            launchState.businessWorkflowVersion > 0
              ? launchState.businessWorkflowVersion
              : routedWorkflow.version
        }
      : null
  }, [
    launchState?.businessWorkflowId,
    launchState?.businessWorkflowSlug,
    launchState?.businessWorkflowVersion,
    workflows
  ])

  const routedProjectId = typeof launchState?.businessProjectId === 'string' ? launchState.businessProjectId.trim() : ''

  const routedGoalDraft =
    typeof launchState?.businessGoalDraft === 'string' ? launchState.businessGoalDraft.slice(0, 4000) : ''

  // A catalog selection owns its approved prompt. A routed draft is only
  // authoritative when the user is adding that workflow to an existing
  // Project, where their Project objective must survive the round trip.
  const initialDraft = routedProjectId
    ? routedGoalDraft || launchedWorkflow?.prompt || ''
    : launchedWorkflow?.prompt || routedGoalDraft

  const [goalDraft, setGoalDraft] = useState(initialDraft)
  const [selectedWorkflow, setSelectedWorkflow] = useState<BusinessWorkflowStarter | null>(launchedWorkflow)
  const [homeVideoWorkflowSelected, setHomeVideoWorkflowSelected] = useState(false)

  const [selectedWorkflowIsTestData, setSelectedWorkflowIsTestData] = useState(
    launchedWorkflow !== null && launchState?.businessWorkflowCatalogProvenance === 'test'
  )

  const [domainError, setDomainError] = useState(false)
  const [domainStarting, setDomainStarting] = useState(false)

  const [videoReadiness, setVideoReadiness] = useState<
    | { state: 'checking' | 'unknown' | 'present' }
    | { state: 'missing'; tools: string[] }
  >({ state: 'checking' })

  const templateAttachmentBlocked = selectedWorkflow !== null && attachments.length > 0

  useEffect(() => {
    if ((!homeVideoWorkflowSelected && selectedWorkflow?.id !== 'viral-video-remake') || connection?.mode === 'remote') {
      return
    }

    const check = workflowDomainBridge()?.localVideoReadiness

    if (!check) {
      setVideoReadiness({ state: 'unknown' })

      return
    }

    let cancelled = false

    setVideoReadiness({ state: 'checking' })
    void check()
      .then(result => {
        if (cancelled) {
          return
        }

        setVideoReadiness(
          !result.ok
            ? { state: 'unknown' }
            : result.basicToolsReady
              ? { state: 'present' }
              : { state: 'missing', tools: result.missing }
        )
      })
      .catch(() => {
        if (!cancelled) {
          setVideoReadiness({ state: 'unknown' })
        }
      })

    return () => {
      cancelled = true
    }
  }, [connection?.mode, homeVideoWorkflowSelected, selectedWorkflow?.id])

  const focusGoal = () => {
    window.document.getElementById(BUSINESS_GOAL_INPUT_ID)?.focus()
  }

  useEffect(() => {
    if (!launchedWorkflow && launchState?.businessGoalFocus !== true) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      window.document.getElementById(BUSINESS_GOAL_INPUT_ID)?.focus()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [launchState?.businessGoalFocus, launchedWorkflow])

  // ChatView is retained while full-page routes temporarily cover it, so a
  // Workflow selection can survive a trip back to the catalog in component
  // state. Treat every new Start navigation as authoritative: a routed
  // template restores its exact id/version, while an explicit plain-goal
  // entry clears the template and its provenance before the next submit.
  useEffect(() => {
    setSelectedWorkflow(launchedWorkflow)
    setHomeVideoWorkflowSelected(false)
    setSelectedWorkflowIsTestData(
      launchedWorkflow !== null && launchState?.businessWorkflowCatalogProvenance === 'test'
    )
    setGoalDraft(
      routedProjectId ? routedGoalDraft || launchedWorkflow?.prompt || '' : launchedWorkflow?.prompt || routedGoalDraft
    )
    setDomainError(false)
  }, [launchState?.businessWorkflowCatalogProvenance, launchedWorkflow, location.key, routedGoalDraft, routedProjectId])

  // A local attachment cannot be silently dropped by the cloud Workflow API.
  // Keep the existing attachment-capable chat route for a home-card draft.
  useEffect(() => {
    if (homeVideoWorkflowSelected && attachments.length > 0) {
      setSelectedWorkflow(null)
      setHomeVideoWorkflowSelected(false)
    }
  }, [attachments.length, homeVideoWorkflowSelected])

  const selectGoal = (starter: BusinessHomeStarter) => {
    const isVideoStarter = starter.id === 'viral-video-remake'

    const videoWorkflow =
      isVideoStarter &&
      attachments.length === 0 &&
      videoCatalog.mode === 'ready' &&
      videoCatalog.items.some(item => item.id === starter.id)
        ? workflows.find(workflow => workflow.id === starter.id) ?? null
        : null

    setSelectedWorkflow(videoWorkflow)
    setHomeVideoWorkflowSelected(isVideoStarter)
    setSelectedWorkflowIsTestData(false)
    setDomainError(false)
    setGoalDraft(starter.prompt)
    focusGoal()
  }

  const submitGoal = async (goal: string): Promise<boolean> => {
    if (!selectedWorkflow) {
      return (await onSubmitGoal?.(goal)) ?? false
    }

    setDomainError(false)
    setDomainStarting(true)

    let starter = selectedWorkflow

    if (homeVideoWorkflowSelected) {
      const catalog = await listVideoWorkflowCatalog()
      const available = catalog.mode === 'ready' ? catalog.items.find(item => item.id === starter.id) : null

      if (!available) {
        setDomainStarting(false)

        return (await onSubmitGoal?.(goal)) ?? false
      }

      starter = { ...starter, version: available.version }
    }

    const projectId = routedProjectId || undefined
    const outcome = await startWorkflowGoal(goal, starter, projectId)

    setDomainStarting(false)

    if (outcome.mode === 'started') {
      navigate(workflowRunRoute(outcome.runId), {
        state: routeDrawerNavigationState(location)
      })

      return true
    }

    if (outcome.mode === 'failed') {
      setDomainError(true)

      return false
    }

    return (await onSubmitGoal?.(goal)) ?? false
  }

  const videoReadinessMessage =
    connection?.mode === 'remote'
      ? t.businessWorkspace.goalLauncher.videoRemoteConnection
      : videoReadiness.state === 'checking'
        ? t.businessWorkspace.goalLauncher.videoToolsChecking
        : videoReadiness.state === 'missing'
          ? t.businessWorkspace.goalLauncher.videoToolsMissing(videoReadiness.tools.join(', '))
          : videoReadiness.state === 'present'
            ? t.businessWorkspace.goalLauncher.videoToolsPresent
            : t.businessWorkspace.goalLauncher.videoToolsUnknown

  return (
    <div
      className="pointer-events-auto mx-auto flex w-full max-w-[52rem] min-w-0 flex-col gap-7 pb-4 text-left"
      data-business-start-home=""
    >
      <header className="relative flex flex-col gap-4">
        <div className="mx-auto w-full max-w-[44rem] sm:pr-[9.5rem]">
          <h1 className="m-0 text-balance text-[clamp(2rem,4vw,2.625rem)] font-semibold leading-[1.12] tracking-[-0.035em] text-foreground">
            {t.home.title}
          </h1>
        </div>
        <Button
          className="shrink-0 self-start sm:absolute sm:right-0 sm:top-0"
          onClick={focusGoal}
          size="sm"
          variant="outline"
        >
          <Codicon name="add" size="0.875rem" />
          {t.businessWorkspace.projects.action}
        </Button>
      </header>

      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-8" data-business-start-content="">
        {selectedWorkflow && (
          <section
            aria-label={t.businessWorkspace.goalLauncher.confirmationEyebrow}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-3 shadow-xs"
            data-workflow-start-confirmation=""
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-primary">{t.businessWorkspace.goalLauncher.confirmationEyebrow}</p>
              <p className="mt-1 truncate text-sm font-medium">
                {t.businessWorkspace.goalLauncher.confirmationTemplate}
                {selectedWorkflow.title} · {t.businessWorkspace.workflows.version(selectedWorkflow.version)}
              </p>
              <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">
                {t.businessWorkspace.goalLauncher.confirmationExecutor}
              </p>
              {selectedWorkflowIsTestData && (
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-200" role="status">
                  {t.businessWorkspace.workflows.testDataNotice}
                </p>
              )}
              {selectedWorkflow.id === 'viral-video-remake' && (
                <p className="mt-2 text-xs text-(--ui-text-secondary)" role="status">
                  {videoReadinessMessage}
                </p>
              )}
            </div>
            <Button
              onClick={() =>
                navigate(WORKFLOWS_ROUTE, {
                  state: {
                    businessGoalDraft: goalDraft,
                    ...(typeof launchState?.businessProjectId === 'string'
                      ? { businessProjectId: launchState.businessProjectId }
                      : {})
                  }
                })
              }
              size="sm"
              variant="ghost"
            >
              {t.businessWorkspace.goalLauncher.changeWorkflow}
            </Button>
          </section>
        )}
        <BusinessGoalLauncher
          attachments={attachments}
          disabled={goalDisabled || domainStarting}
          draft={goalDraft}
          onDraftChange={draft => {
            setGoalDraft(draft)
          }}
          onPickFiles={onPickFiles}
          onPickFolders={onPickFolders}
          onPickImages={onPickImages}
          onRemoveAttachment={onRemoveAttachment}
          onSubmit={submitGoal}
          submitBlockedReason={
            templateAttachmentBlocked ? t.businessWorkspace.goalLauncher.workflowAttachmentsUnsupported : undefined
          }
        />
        {homeVideoWorkflowSelected && !selectedWorkflow && (
          <p className="-mt-4 text-xs text-(--ui-text-secondary)" role="status">
            {t.businessWorkspace.goalLauncher.videoLocalChatMode} {videoReadinessMessage}
          </p>
        )}
        {domainError && (
          <p className="-mt-4 text-xs text-destructive" role="alert">
            {t.businessWorkspace.workflowDomain.startFailed}
          </p>
        )}
        <BusinessStartShelf onSelectGoal={selectGoal} />
      </div>
    </div>
  )
}
