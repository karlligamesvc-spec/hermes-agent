import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'
import { $sessions, $sessionsLoading } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { $tasks } from '@/store/tasks'

import { openSession } from '../../open-session'
import {
  DELIVERABLES_ROUTE,
  HISTORY_ROUTE,
  NEW_CHAT_ROUTE,
  projectDetailRoute,
  routeDrawerNavigationState,
  taskDetailRoute,
  TASKS_ROUTE,
  WORKFLOWS_ROUTE
} from '../../routes'
import { jobTitleShort, taskPhase } from '../../tasks/task-model'
import { openWorkspaceArtifact } from '../api/artifacts-adapter'
import { BusinessPageHeader } from '../components/business-page-header'
import { BusinessLimitation, BusinessSection } from '../components/business-section'
import { useWorkflowProjects } from '../hooks/use-workflow-domain-lists'
import { useWorkspaceEvidence } from '../hooks/use-workspace-evidence'
import { distinctProjectObjective } from '../view-model/project'
import { recentConversations, recentWorkspaceTasks } from '../view-model/workspace'

type ProjectFilter = 'active' | 'all' | 'completed'

const completedProjectStates = new Set(['archived', 'cancelled', 'completed', 'succeeded'])

function projectStatus(project: { status: string; summary?: { currentRunStatus: null | string } }) {
  return project.summary?.currentRunStatus || project.status
}

function isCompletedProject(status: string) {
  return completedProjectStates.has(status)
}

export function ProjectsView() {
  const { locale, t } = useI18n()
  const c = t.businessWorkspace.projects
  const location = useLocation()
  const navigate = useNavigate()
  const projects = useWorkflowProjects()
  const [filter, setFilter] = useState<ProjectFilter>('all')

  if (projects.mode === 'unavailable') {
    return <LegacyProjectsView />
  }

  if (projects.mode === 'failed') {
    return <LegacyProjectsView notice={c.projectLoadFailed} />
  }

  const newProject = () => navigate(NEW_CHAT_ROUTE, { state: { businessGoalDraft: '', businessGoalFocus: true } })

  const visibleProjects =
    projects.mode === 'ready'
      ? projects.items.filter(project => {
          if (filter === 'all') {
            return true
          }

          return filter === 'completed'
            ? isCompletedProject(projectStatus(project))
            : !isCompletedProject(projectStatus(project))
        })
      : []

  const counts =
    projects.mode === 'ready'
      ? {
          active: projects.items.filter(project => !isCompletedProject(projectStatus(project))).length,
          all: projects.total,
          completed: projects.items.filter(project => isCompletedProject(projectStatus(project))).length
        }
      : { active: 0, all: 0, completed: 0 }

  return (
    <section className="h-full overflow-y-auto bg-(--ui-chat-surface-background) px-6 py-8 min-[1100px]:px-9">
      <div className="mx-auto w-full max-w-[65.625rem]">
        <BusinessPageHeader
          action={{ icon: 'add', label: c.newProject, onClick: newProject }}
          description={c.description}
          eyebrow={c.eyebrow}
          icon="folder"
          title={c.title}
        />
      </div>
      {projects.mode === 'loading' ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={c.loadingProjects} type="lemniscate-bloom" />
          <span>{c.loadingProjects}</span>
        </div>
      ) : projects.items.length === 0 ? (
        <div className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center">
          <div>
            <Codicon className="mx-auto text-primary" name="folder" size="1.75rem" />
            <EmptyState description={c.emptyDescription} title={c.emptyTitle} />
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={newProject} size="sm">
                <Codicon name="edit" size="0.875rem" />
                {c.action}
              </Button>
              <Button onClick={() => navigate(WORKFLOWS_ROUTE)} size="sm" variant="outline">
                {c.chooseWorkflow}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[65.625rem] py-6" data-workflow-project-list="">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div aria-label={c.filters.label} className="flex flex-wrap gap-2" role="group">
              {(['all', 'active', 'completed'] as const).map(item => (
                <Button
                  aria-pressed={filter === item}
                  key={item}
                  onClick={() => setFilter(item)}
                  size="sm"
                  variant={filter === item ? 'secondary' : 'ghost'}
                >
                  {c.filters[item]}
                  <span className="text-(--ui-text-tertiary)">{counts[item]}</span>
                </Button>
              ))}
            </div>
            <p className="text-xs text-(--ui-text-tertiary)">{c.totalProjects(projects.total)}</p>
          </div>

          {visibleProjects.length === 0 ? (
            <div className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-5 py-10 text-center text-sm text-muted-foreground">
              {c.filterEmpty}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) shadow-sm">
              {visibleProjects.map(project => {
                const summary = project.summary
                const status = projectStatus(project)
                const objective = distinctProjectObjective(project)

                const progress = summary?.currentStepTitle
                  ? c.currentStep(summary.currentStepTitle)
                  : summary && summary.stepTotal > 0
                    ? c.steps(summary.stepCompleted, summary.stepTotal)
                    : c.lifecycle(status)

                return (
                  <Button
                    className="grid h-auto w-full gap-4 rounded-none border-b border-(--ui-stroke-tertiary) px-5 py-4 text-left last:border-b-0 hover:bg-(--chrome-action-hover) sm:grid-cols-[minmax(0,1fr)_auto]"
                    key={project.id}
                    onClick={() =>
                      navigate(projectDetailRoute(project.id), {
                        state: { ...routeDrawerNavigationState(location), businessProjectSummary: summary }
                      })
                    }
                    type="button"
                    variant="ghost"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            summary?.attention === 'failed'
                              ? 'size-2 shrink-0 rounded-full bg-destructive'
                              : summary?.attention === 'review'
                                ? 'size-2 shrink-0 rounded-full bg-amber-500'
                                : status === 'running'
                                  ? 'size-2 shrink-0 animate-pulse rounded-full bg-primary'
                                  : 'size-2 shrink-0 rounded-full bg-(--ui-text-quaternary)'
                          }
                        />
                        <strong className="truncate text-sm font-semibold">{project.name}</strong>
                        <Badge
                          variant={
                            summary?.attention === 'failed'
                              ? 'destructive'
                              : summary?.attention === 'review'
                                ? 'warn'
                                : 'muted'
                          }
                        >
                          {progress}
                        </Badge>
                      </span>
                      {objective && (
                        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                          {objective}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-4 self-center text-xs text-(--ui-text-tertiary)">
                      <span>{c.updatedAt(formatBusinessDayTime(new Date(project.updatedAt), locale))}</span>
                      {summary && summary.deliverableCount > 0 && (
                        <span>{c.deliverableCount(summary.deliverableCount)}</span>
                      )}
                      <span>{c.viewProject}</span>
                      <Codicon name="arrow-right" size="0.75rem" />
                    </span>
                  </Button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function LegacyProjectsView({ notice }: { notice?: string } = {}) {
  const { locale, t } = useI18n()
  const c = t.businessWorkspace.projects
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const sessionsLoading = useStore($sessionsLoading)
  const states = useStore($sessionStates)
  const tasks = useStore($tasks)
  const conversations = useMemo(() => recentConversations(sessions, states), [sessions, states])
  const recentTasks = useMemo(() => recentWorkspaceTasks(tasks), [tasks])
  const { evidence, evidenceUnavailable } = useWorkspaceEvidence(sessions, recentTasks)

  const artifacts = evidence?.artifacts.slice(0, 4) ?? []
  const hasHistory = conversations.length > 0 || recentTasks.length > 0 || artifacts.length > 0
  const hasChildReadFailures = Boolean(evidence?.failedTasks || evidence?.failedArtifactSessions)
  const showEvidenceFailure = !sessionsLoading && evidenceUnavailable && !hasHistory

  const showRealEmpty =
    !sessionsLoading && !evidenceUnavailable && evidence !== null && !hasChildReadFailures && !hasHistory

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-(--ui-chat-surface-background) px-(--page-inset-x) py-8">
      <header className="mx-auto w-full max-w-4xl border-b border-(--ui-stroke-tertiary) pb-5">
        <p className="text-xs font-medium text-primary">{c.eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{c.description}</p>
        {notice && (
          <p className="mt-3 text-xs text-amber-600" role="alert">
            {notice}
          </p>
        )}
        <p className="mt-2 text-[0.6875rem] text-(--ui-text-tertiary)">{c.legacyFallback}</p>
      </header>
      {showEvidenceFailure ? (
        <div className="mx-auto grid w-full max-w-4xl flex-1 place-items-center py-10 text-center">
          <div>
            <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
            <EmptyState description={c.evidenceUnavailableDescription} title={c.evidenceUnavailableTitle} />
            <div className="flex justify-center gap-2">
              <Button onClick={() => navigate(NEW_CHAT_ROUTE)} size="sm">
                {c.action}
              </Button>
              <Button onClick={() => navigate(DELIVERABLES_ROUTE)} size="sm" variant="outline">
                {c.openArtifacts}
              </Button>
            </div>
          </div>
        </div>
      ) : showRealEmpty ? (
        <div className="mx-auto grid w-full max-w-4xl flex-1 place-items-center py-10">
          <div className="text-center">
            <Codicon className="mx-auto text-primary" name="folder" size="1.75rem" />
            <EmptyState description={c.emptyDescription} title={c.emptyTitle} />
            <div className="flex justify-center gap-2">
              <Button onClick={() => navigate(NEW_CHAT_ROUTE)} size="sm">
                <Codicon name="edit" size="0.875rem" />
                {c.action}
              </Button>
              <Button onClick={() => navigate(TASKS_ROUTE)} size="sm" variant="outline">
                <Codicon name="rocket" size="0.875rem" />
                {c.tasksAction}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-4xl gap-8 py-6">
          <BusinessSection
            action={c.openHistory}
            onAction={() => navigate(HISTORY_ROUTE)}
            title={c.recentConversations}
          >
            {conversations.length > 0 ? (
              conversations.map(conversation => (
                <button
                  className="flex w-full items-start gap-3 border-b border-(--ui-stroke-tertiary) py-3 text-left last:border-b-0 hover:bg-(--chrome-action-hover)"
                  key={conversation.id}
                  onClick={() => openSession(conversation.id, navigate)}
                  type="button"
                >
                  <span
                    className={
                      conversation.status === 'needs-input'
                        ? 'mt-1.5 size-2 shrink-0 rounded-full bg-amber-500'
                        : conversation.status === 'running'
                          ? 'mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-primary'
                          : 'mt-1.5 size-2 shrink-0 rounded-full bg-(--ui-text-quaternary)'
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{conversation.title || c.untitled}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {conversation.preview || c.noPreview}
                    </span>
                    <span className="mt-0.5 block text-[0.7rem] text-(--ui-text-tertiary)">
                      {c.toolActivity(conversation.toolCallCount)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[0.7rem] text-(--ui-text-tertiary)">
                    {conversation.status === 'needs-input'
                      ? c.needsInput
                      : conversation.status === 'running'
                        ? c.running
                        : formatBusinessDayTime(new Date(conversation.lastActive * 1000), locale)}
                  </span>
                </button>
              ))
            ) : (
              <BusinessLimitation text={sessionsLoading ? c.loadingHistory : c.noConversations} />
            )}
            <BusinessLimitation text={c.toolStatusDetail} />
          </BusinessSection>

          <BusinessSection action={c.openTasks} onAction={() => navigate(TASKS_ROUTE)} title={c.taskProgress}>
            {recentTasks.length > 0 ? (
              recentTasks.map(task => {
                const taskEvidence = evidence?.tasks[task.id]
                const progress = taskEvidence?.progress
                const phase = taskPhase(task)

                return (
                  <button
                    className="block w-full border-b border-(--ui-stroke-tertiary) py-3 text-left last:border-b-0 hover:bg-(--chrome-action-hover)"
                    key={task.id}
                    onClick={() => navigate(taskDetailRoute(task.id))}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium">{jobTitleShort(task)}</span>
                      <span className="shrink-0 text-[0.7rem] text-(--ui-text-tertiary)">
                        {phase === 'running' ? c.running : phase === 'failed' ? c.failed : c.done}
                      </span>
                    </div>
                    {evidenceUnavailable || taskEvidence?.readState === 'unavailable' ? (
                      <p className="mt-1 text-xs text-muted-foreground">{c.taskProgressUnavailable}</p>
                    ) : !evidence ? (
                      <p className="mt-1 text-xs text-muted-foreground">{c.taskProgressLoading}</p>
                    ) : progress?.totalSteps ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.steps(progress.completedSteps, progress.totalSteps)}
                        {progress.currentStep ? ` · ${progress.currentStep}` : ''}
                      </p>
                    ) : progress?.latestOutput ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {c.latestOutput}: {progress.latestOutput}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">{c.progressUnavailable}</p>
                    )}
                  </button>
                )
              })
            ) : (
              <BusinessLimitation text={c.noTasks} />
            )}
          </BusinessSection>

          <BusinessSection
            action={c.openArtifacts}
            onAction={() => navigate(DELIVERABLES_ROUTE)}
            title={c.deliverables}
          >
            {artifacts.length > 0 ? (
              artifacts.map(artifact => (
                <button
                  className="flex w-full items-center gap-3 border-b border-(--ui-stroke-tertiary) py-3 text-left last:border-b-0 hover:bg-(--chrome-action-hover)"
                  key={artifact.id}
                  onClick={() => void openWorkspaceArtifact(artifact.href, t.artifacts.openFailed)}
                  type="button"
                >
                  <Codicon className="shrink-0 text-primary" name={artifact.kind === 'link' ? 'link' : 'file'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{artifact.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{artifact.sessionTitle}</span>
                  </span>
                </button>
              ))
            ) : (
              <BusinessLimitation
                text={
                  evidenceUnavailable || evidence?.failedArtifactSessions
                    ? c.partialEvidence
                    : evidence
                      ? c.noArtifacts
                      : c.loadingEvidence
                }
              />
            )}
          </BusinessSection>

          {!evidenceUnavailable && (Boolean(evidence?.failedTasks) || Boolean(evidence?.failedArtifactSessions)) && (
            <BusinessLimitation text={c.partialEvidence} />
          )}
        </div>
      )}
    </section>
  )
}
