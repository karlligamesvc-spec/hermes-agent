import { useLocation, useNavigate, useParams } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'

import {
  NEW_CHAT_ROUTE,
  PROJECTS_ROUTE,
  routeDrawerBackgroundLocation,
  routeDrawerNavigationState,
  workflowRunRoute,
  WORKFLOWS_ROUTE
} from '../../routes'
import type { WorkflowProjectSummary } from '../api/types'
import { useWorkflowDefinitions, useWorkflowProject } from '../hooks/use-workflow-domain-lists'
import { distinctProjectObjective, projectCurrentRunId } from '../view-model/project'

function routedProjectSummary(state: unknown): WorkflowProjectSummary | undefined {
  if (!state || typeof state !== 'object') {
    return undefined
  }

  const summary = (state as { businessProjectSummary?: unknown }).businessProjectSummary

  if (!summary || typeof summary !== 'object') {
    return undefined
  }

  const candidate = summary as Partial<WorkflowProjectSummary>

  return typeof candidate.currentRunId === 'string' || candidate.currentRunId === null
    ? (candidate as WorkflowProjectSummary)
    : undefined
}

export function ProjectDetailView() {
  const { locale, t } = useI18n()
  const copy = t.businessWorkspace.projects
  const { projectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const project = useWorkflowProject(projectId)
  const workflows = useWorkflowDefinitions({ limit: 50, projectId })
  const routeSummary = routedProjectSummary(location.state)

  if (project.mode === 'loading') {
    return (
      <div className="grid h-full place-items-center px-6 py-10 text-sm text-muted-foreground">
        <Loader className="size-8" label={copy.loadingProjectDetail} type="lemniscate-bloom" />
        <span className="mt-3">{copy.loadingProjectDetail}</span>
      </div>
    )
  }

  if (project.mode !== 'ready') {
    return (
      <div className="grid h-full place-items-center overflow-y-auto px-6 py-10 text-center">
        <div>
          <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
          <EmptyState description={copy.detailUnavailableDescription} title={copy.detailUnavailableTitle} />
          <Button onClick={() => navigate(PROJECTS_ROUTE)} size="sm" variant="outline">
            {copy.backToProjects}
          </Button>
        </div>
      </div>
    )
  }

  const item = project.item
  const objective = distinctProjectObjective(item)
  const summary = routeSummary ?? item.summary
  const currentRunId = projectCurrentRunId(summary)
  const currentRunStatus = summary?.currentRunStatus ?? null

  const openRun = () => {
    if (!currentRunId) {
      return
    }

    const state = routeDrawerBackgroundLocation(location.state)
      ? location.state
      : routeDrawerNavigationState({ hash: '', pathname: PROJECTS_ROUTE, search: '', state: null })

    navigate(workflowRunRoute(currentRunId), { replace: true, state })
  }

  const continueGoal = () =>
    navigate(NEW_CHAT_ROUTE, {
      state: { businessGoalDraft: item.objective, businessGoalFocus: true }
    })

  return (
    <section className="h-full overflow-y-auto bg-(--ui-chat-surface-background) px-6 pb-8 pt-12" data-project-detail="">
      <div className="mx-auto w-full max-w-xl">
        <p className="text-xs font-medium text-primary">{copy.detailEyebrow}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 pr-8">
          <h1 className="min-w-0 text-balance text-2xl font-semibold tracking-tight">{item.name}</h1>
          <Badge variant="muted">{copy.lifecycle(item.status)}</Badge>
        </div>
        {objective && <p className="mt-3 text-sm leading-6 text-muted-foreground">{objective}</p>}

        <dl className="mt-6 grid gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-(--ui-text-tertiary)">{copy.createdAtLabel}</dt>
            <dd className="mt-1 text-foreground">{formatBusinessDayTime(new Date(item.createdAt), locale)}</dd>
          </div>
          <div>
            <dt className="text-(--ui-text-tertiary)">{copy.updatedAtLabel}</dt>
            <dd className="mt-1 text-foreground">{formatBusinessDayTime(new Date(item.updatedAt), locale)}</dd>
          </div>
        </dl>

        <div className="mt-6 border-t border-(--ui-stroke-tertiary) pt-6">
          {currentRunId ? (
            <div className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-primary">{copy.currentRunTitle}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {currentRunStatus ? copy.lifecycle(currentRunStatus) : copy.runStatusUnavailable}
                  </p>
                </div>
                <Button onClick={openRun} size="sm">
                  <Codicon name="arrow-right" size="0.875rem" />
                  {copy.viewRun}
                </Button>
              </div>
            </div>
          ) : summary ? (
            <div className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-5 text-center">
              <EmptyState description={copy.noRunDescription} title={copy.noRunTitle} />
              <Button onClick={continueGoal} size="sm">
                {copy.continueGoal}
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-5 text-center">
              <EmptyState description={copy.runSummaryUnavailable} title={copy.runSummaryUnavailableTitle} />
              <Button onClick={continueGoal} size="sm">
                {copy.continueGoal}
              </Button>
            </div>
          )}
        </div>

        <section className="mt-6 border-t border-(--ui-stroke-tertiary) pt-6" data-project-workflows="">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{copy.workflowsTitle}</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.workflowsDescription}</p>
            </div>
            <Button
              onClick={() =>
                navigate(WORKFLOWS_ROUTE, {
                  state: { businessGoalDraft: item.objective, businessProjectId: item.id }
                })
              }
              size="sm"
              variant="outline"
            >
              <Codicon name="add" size="0.875rem" />
              {copy.addWorkflow}
            </Button>
          </div>
          {workflows.mode === 'loading' ? (
            <p className="mt-4 text-xs text-muted-foreground">{copy.loadingWorkflows}</p>
          ) : workflows.mode === 'ready' && workflows.items.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated)">
              {workflows.items.map(workflow => (
                <div
                  className="flex items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) px-4 py-3 last:border-b-0"
                  key={workflow.id}
                >
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{workflow.name}</strong>
                    {workflow.description && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{workflow.description}</span>
                    )}
                  </span>
                  <Badge variant="muted">{copy.lifecycle(workflow.status)}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-(--ui-stroke-secondary) px-4 py-4 text-xs leading-5 text-muted-foreground">
              {workflows.mode === 'ready' ? copy.noWorkflows : copy.workflowsUnavailable}
            </p>
          )}
        </section>
      </div>
    </section>
  )
}
