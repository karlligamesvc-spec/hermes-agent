import '../project-prototype.css'

import { useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { TabsContent, TabsList, Tabs as TabsRoot, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'

import {
  NEW_CHAT_ROUTE,
  PROJECTS_ROUTE,
  projectWorkflowsRoute,
  routeDrawerBackgroundLocation,
  routeDrawerNavigationState,
  workflowRunRoute
} from '../../routes'
import { completeWorkflowProject, reopenWorkflowProject, startExistingWorkflowRun } from '../api/adapters'
import type { WorkflowProjectSummary } from '../api/types'
import { ProjectEditDialog } from '../components/project-edit-dialog'
import { ProjectResults } from '../components/project-results'
import { WorkflowRefreshNotice } from '../components/workflow-refresh-notice'
import {
  useWorkflowDefinitions,
  useWorkflowProject,
  useWorkflowProjectCompletion
} from '../hooks/use-workflow-domain-lists'
import { PROJECT_PROTOTYPE_COPY } from '../project-prototype-copy'
import { distinctProjectObjective, projectCurrentRunId } from '../view-model/project'
import { projectPresentationStage } from '../view-model/project-presentation'

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
  const prototype = PROJECT_PROTOTYPE_COPY[locale]
  const [tab, setTab] = useState('overview')
  const { projectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [reloadToken, setReloadToken] = useState(0)
  const project = useWorkflowProject(projectId, reloadToken)
  const completion = useWorkflowProjectCompletion(projectId, reloadToken)
  const workflows = useWorkflowDefinitions({ limit: 50, projectId }, reloadToken)
  const routeSummary = routedProjectSummary(location.state)
  const [startingWorkflowId, setStartingWorkflowId] = useState<string | null>(null)
  const [runError, setRunError] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [lifecyclePending, setLifecyclePending] = useState(false)
  const [lifecycleError, setLifecycleError] = useState<'not-ready' | 'failed' | null>(null)

  if (project.mode === 'loading') {
    return (
      <div className="grid h-full place-items-center px-6 py-10 text-sm text-muted-foreground">
        <Loader className="size-8" label={copy.loadingProjectDetail} type="lemniscate-bloom" />
        <span className="mt-3">{copy.loadingProjectDetail}</span>
      </div>
    )
  }

  if (project.mode !== 'ready' || project.item.id !== projectId) {
    return (
      <div className="grid h-full place-items-center overflow-y-auto px-6 py-10 text-center">
        <div>
          <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
          <EmptyState description={copy.detailUnavailableDescription} title={copy.detailUnavailableTitle} />
          <WorkflowRefreshNotice state={project} />
          <Button onClick={() => navigate(PROJECTS_ROUTE)} size="sm" variant="outline">
            {copy.backToProjects}
          </Button>
        </div>
      </div>
    )
  }

  const item = project.item
  const objective = distinctProjectObjective(item)
  const summary = item.summary ?? routeSummary
  const currentRunId = projectCurrentRunId(summary)
  const currentRunStatus = summary?.currentRunStatus ?? null
  const completionFacts = completion.mode === 'ready' ? completion.completion : null
  const workflowStates = new Map(completionFacts?.workflowStates.map(state => [state.workflowId, state]) ?? [])

  const presentation = projectPresentationStage(item, completionFacts)
  const stage = presentation ? prototype.filters[presentation] : item.status !== 'active' ? copy.lifecycle(item.status) : prototype.unknown

  const lifecycle = [true, completionFacts ? completionFacts.workflowTotal > 0 : null,
    completionFacts ? completionFacts.readyForReview && completionFacts.workflowTotal > 0 && completionFacts.workflowSucceeded === completionFacts.workflowTotal : null, item.status === 'completed']

  const openWorkflowRun = (runId: string) => {
    const state = routeDrawerBackgroundLocation(location.state)
      ? location.state
      : routeDrawerNavigationState({ hash: '', pathname: PROJECTS_ROUTE, search: '', state: null })

    navigate(workflowRunRoute(runId), { replace: true, state })
  }

  const openRun = () => {
    if (currentRunId) {
      openWorkflowRun(currentRunId)
    }
  }

  const startWorkflow = async (workflowId: string) => {
    if (startingWorkflowId || item.status === 'completed') {
      return
    }

    setStartingWorkflowId(workflowId)
    setRunError(false)
    const outcome = await startExistingWorkflowRun(item.objective, workflowId)
    setStartingWorkflowId(null)

    if (outcome.mode === 'started') {
      openWorkflowRun(outcome.runId)
    } else {
      setRunError(true)
    }
  }

  const changeLifecycle = async () => {
    if (lifecyclePending) {
      return
    }

    setLifecyclePending(true)
    setLifecycleError(null)

    const result = item.status === 'completed'
      ? await reopenWorkflowProject(item.id)
      : await completeWorkflowProject(item.id)

    setLifecyclePending(false)

    if (result.mode === 'updated') {
      setReloadToken(token => token + 1)

      return
    }

    setLifecycleError(result.mode === 'failed' && result.code === 'project_not_ready' ? 'not-ready' : 'failed')
    setReloadToken(token => token + 1)
  }

  const continueGoal = () =>
    navigate(NEW_CHAT_ROUTE, {
      state: { businessGoalDraft: item.objective, businessGoalFocus: true }
    })

  return (
    <section className="apex-project-detail" data-project-detail="">
      <header className="apex-project-detail-header">
        <p className="text-xs font-medium text-primary">{copy.detailEyebrow}</p>
        <WorkflowRefreshNotice state={project} />
        <div className="mt-2 flex flex-wrap items-center gap-2 pr-8">
          <h1 className="min-w-0 text-balance text-2xl font-semibold tracking-tight">{item.name}</h1>
          <Badge data-project-status="" variant="muted">{copy.lifecycle(item.status)}</Badge>
          {stage !== copy.lifecycle(item.status) && <Badge variant="muted">{stage}</Badge>}
        </div>
      </header>
      <TabsRoot className="apex-project-detail-tabs" onValueChange={setTab} value={tab}>
        <TabsList aria-label={prototype.tabs}>
          <TabsTrigger value="overview">{prototype.overview}</TabsTrigger>
          <TabsTrigger value="workflows">{prototype.workflows}{completionFacts ? ` ${completionFacts.workflowTotal}` : ''}</TabsTrigger>
          <TabsTrigger value="results">{prototype.results}{summary ? ` ${summary.deliverableCount}` : ''}</TabsTrigger>
        </TabsList>
        <TabsContent className="apex-project-detail-body" value="overview">
          <section>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{prototype.goal}</h2>
              <Button onClick={() => setEditOpen(true)} size="sm" variant="ghost"><Codicon name="edit" size="0.875rem" />{copy.editProject}</Button>
            </div>
            {objective && <p className="mt-3 text-sm leading-6 text-muted-foreground">{objective}</p>}
            <p className="mt-4 text-xs leading-5 text-muted-foreground">{prototype.relationship}</p>
          </section>
          <WorkflowRefreshNotice state={completion} />
          <ol aria-label={prototype.progress} className="apex-project-lifecycle">
            {prototype.stages.map((label, index) => <li data-complete={lifecycle[index] === true} data-known={lifecycle[index] !== null} key={label}>
              <span className="apex-project-lifecycle-number">{lifecycle[index] === true ? <Codicon name="check" size="0.875rem" /> : index + 1}</span>
              <strong>{label}</strong><span className="apex-project-lifecycle-description">{prototype.stageDescriptions[index]}</span>
            </li>)}
          </ol>
          <p className="text-xs text-muted-foreground">{completionFacts ? copy.completionProgress(completionFacts.workflowSucceeded, completionFacts.workflowTotal) : copy.completionUnavailable}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={item.status === 'completed'} onClick={() => setTab('workflows')} size="sm" variant="outline">{completionFacts?.workflowTotal === 0 ? copy.addWorkflow : prototype.viewWorkflows}</Button>
            {completionFacts?.readyForReview && <Button onClick={() => setTab('results')} size="sm">{prototype.reviewResults}</Button>}
          </div>

        <div className="mt-6 border-t border-(--ui-stroke-tertiary) pt-6">
          {currentRunId ? (
            <div className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-primary">{copy.currentRunTitle}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {currentRunStatus ? copy.runLifecycle(currentRunStatus) : copy.runStatusUnavailable}
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

          <dl className="mt-6 grid gap-3 border-t border-(--ui-stroke-tertiary) pt-4 text-xs sm:grid-cols-2">
            <div><dt className="text-muted-foreground">{copy.createdAtLabel}</dt><dd className="mt-1">{formatBusinessDayTime(new Date(item.createdAt), locale)}</dd></div>
            <div><dt className="text-muted-foreground">{copy.updatedAtLabel}</dt><dd className="mt-1">{formatBusinessDayTime(new Date(item.updatedAt), locale)}</dd></div>
          </dl>
        </TabsContent>
        <TabsContent className="apex-project-detail-body" value="workflows">

        <section className="mt-6 border-t border-(--ui-stroke-tertiary) pt-6" data-project-workflows="">
          <WorkflowRefreshNotice state={workflows} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{copy.workflowsTitle}</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.workflowsDescription}</p>
            </div>
            <Button
              disabled={item.status === 'completed'}
              onClick={() =>
                navigate(projectWorkflowsRoute(item.id), {
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
          {item.status === 'completed' && <p className="mt-3 text-xs text-muted-foreground">{copy.reopenFirst}</p>}
          {workflows.mode === 'loading' ? (
            <p className="mt-4 text-xs text-muted-foreground">{copy.loadingWorkflows}</p>
          ) : workflows.mode === 'ready' && workflows.items.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated)">
              {workflows.items.map(workflow => {
                const run = workflowStates.get(workflow.id)
                const runId = run?.runId

                return <div
                  className="flex items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) px-4 py-3 last:border-b-0"
                  key={workflow.id}
                >
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{workflow.name}</strong>
                    {workflow.description && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {workflow.description}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant="muted">{run?.runStatus ? copy.runLifecycle(run.runStatus) : run?.runId === null ? copy.notStarted : copy.runStatusUnavailable}</Badge>
                    {runId && (
                      <Button onClick={() => openWorkflowRun(runId)} size="sm" variant="ghost">
                        {copy.viewRun}
                      </Button>
                    )}
                    <Button
                      aria-busy={startingWorkflowId === workflow.id || undefined}
                      disabled={item.status === 'completed' || startingWorkflowId !== null || workflow.status !== 'active'}
                      onClick={() => void startWorkflow(workflow.id)}
                      size="sm"
                      variant="outline"
                    >
                      {startingWorkflowId === workflow.id ? copy.startingWorkflow : copy.startWorkflow}
                    </Button>
                  </span>
                </div>
              })}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-(--ui-stroke-secondary) px-4 py-4 text-xs leading-5 text-muted-foreground">
              {workflows.mode === 'ready' ? copy.noWorkflows : copy.workflowsUnavailable}
            </p>
          )}
          {runError && (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {copy.runWorkflowFailed}
            </p>
          )}
        </section>
        </TabsContent>
        <TabsContent className="apex-project-detail-body" value="results">
          <ProjectResults projectId={item.id} />
          <p className="mt-5 text-xs leading-5 text-muted-foreground">{prototype.finishHint}</p>
        <section className="mt-6 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-4" data-project-completion="">
          <WorkflowRefreshNotice state={completion} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{stage}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {completionFacts
                  ? copy.completionProgress(completionFacts.workflowSucceeded, completionFacts.workflowTotal)
                  : copy.completionUnavailable}
              </p>
            </div>
            {item.status === 'completed' ? (
              <Button aria-busy={lifecyclePending || undefined} disabled={lifecyclePending} onClick={() => void changeLifecycle()} size="sm" variant="outline">
                {copy.reopenProject}
              </Button>
            ) : completionFacts ? (
              <Button
                aria-busy={lifecyclePending || undefined}
                disabled={!completionFacts.canComplete || lifecyclePending}
                onClick={() => void changeLifecycle()}
                size="sm"
              >
                {copy.completeProject}
              </Button>
            ) : null}
          </div>
          {lifecycleError && (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {lifecycleError === 'not-ready' ? copy.completionNotReady : copy.completionFailed}
            </p>
          )}
        </section>

        </TabsContent>
      </TabsRoot>

        <ProjectEditDialog
          onOpenChange={setEditOpen}
          onSaved={() => setReloadToken(token => token + 1)}
          open={editOpen}
          project={item}
        />
    </section>
  )
}
