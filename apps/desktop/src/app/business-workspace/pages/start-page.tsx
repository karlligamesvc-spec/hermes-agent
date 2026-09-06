import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

import { routeDrawerNavigationState, workflowRunRoute, WORKFLOWS_ROUTE } from '../../routes'
import { startWorkflowGoal } from '../api/adapters'
import { BUSINESS_GOAL_INPUT_ID, BusinessGoalLauncher } from '../components/business-goal-launcher'
import { BusinessStartShelf } from '../components/start-shelf'
import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'
import { businessWorkflowStarters } from '../view-model/workflow-starters'

export interface BusinessStartHomeProps {
  goalDisabled?: boolean
  onSubmitGoal?: (goal: string) => Promise<boolean> | boolean
}

/**
 * Prototype-aligned frame for the business Start route.
 *
 * The top action and starter shelf share one goal field. When the authenticated
 * workflow-domain bridge is available, submission creates the canonical
 * Project → Workflow → Run chain; older/dark shells retain the chat fallback.
 */
export function BusinessStartHome({ goalDisabled = false, onSubmitGoal }: BusinessStartHomeProps) {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const workflows = useMemo(() => businessWorkflowStarters(t.businessWorkspace.workflows), [t])

  const launchState = location.state as null | {
    businessGoalDraft?: unknown
    businessGoalFocus?: unknown
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

  const initialDraft =
    launchedWorkflow?.prompt ??
    (typeof launchState?.businessGoalDraft === 'string' ? launchState.businessGoalDraft.slice(0, 4000) : '')

  const [goalDraft, setGoalDraft] = useState(initialDraft)
  const [selectedWorkflow, setSelectedWorkflow] = useState<BusinessWorkflowStarter | null>(launchedWorkflow)
  const [domainError, setDomainError] = useState(false)
  const [domainStarting, setDomainStarting] = useState(false)

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

  const selectWorkflow = (workflow: BusinessWorkflowStarter) => {
    setSelectedWorkflow(workflow)
    setGoalDraft(workflow.prompt)
    focusGoal()
  }

  const submitGoal = async (goal: string): Promise<boolean> => {
    setDomainError(false)
    setDomainStarting(true)

    const outcome = await startWorkflowGoal(
      goal,
      selectedWorkflow ?? {
        businessPath: 'desktop_goal',
        icon: 'graph',
        id: 'desktop-goal',
        prompt: goal,
        recommended: false,
        slug: 'desktop-goal',
        summary: t.home.description,
        title: t.home.title,
        version: 1
      }
    )

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

  return (
    <div
      className="pointer-events-auto mx-auto flex w-full max-w-[48rem] min-w-0 flex-col gap-6"
      data-business-start-home=""
    >
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="max-w-[48rem]">
          <h1 className="m-0 text-balance text-[2rem] font-semibold leading-tight tracking-[-0.02em] text-foreground">
            {t.home.title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t.home.description}</p>
        </div>
        <Button className="shrink-0 self-start" onClick={focusGoal} size="sm" variant="outline">
          <Codicon name="add" size="0.875rem" />
          {t.businessWorkspace.projects.action}
        </Button>
      </header>

      <div className="flex w-full flex-col gap-7">
        {selectedWorkflow && (
          <section
            aria-label={t.businessWorkspace.goalLauncher.confirmationEyebrow}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-3"
            data-workflow-start-confirmation=""
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-primary">
                {t.businessWorkspace.goalLauncher.confirmationEyebrow}
              </p>
              <p className="mt-1 truncate text-sm font-medium">
                {t.businessWorkspace.goalLauncher.confirmationTemplate}
                {selectedWorkflow.title} · {t.businessWorkspace.workflows.version(selectedWorkflow.version)}
              </p>
              <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">
                {t.businessWorkspace.goalLauncher.confirmationExecutor}
              </p>
            </div>
            <Button onClick={() => navigate(WORKFLOWS_ROUTE)} size="sm" variant="ghost">
              {t.businessWorkspace.goalLauncher.changeWorkflow}
            </Button>
          </section>
        )}
        <BusinessGoalLauncher
          disabled={goalDisabled || domainStarting}
          draft={goalDraft}
          onDraftChange={draft => {
            setGoalDraft(draft)
          }}
          onSubmit={submitGoal}
        />
        {domainError && (
          <p className="-mt-4 text-xs text-destructive" role="alert">
            {t.businessWorkspace.workflowDomain.startFailed}
          </p>
        )}
        <BusinessStartShelf onSelectWorkflow={selectWorkflow} />
      </div>
    </div>
  )
}
