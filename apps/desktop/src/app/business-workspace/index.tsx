import { useStore } from '@nanostores/react'
import { type ReactNode, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { fmtDayTime } from '@/lib/time'
import { $sessions, $sessionsLoading } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { $tasks } from '@/store/tasks'

import { requestComposerFocus, requestComposerInsert } from '../chat/composer/focus'
import { openSession } from '../open-session'
import { ARTIFACTS_ROUTE, NEW_CHAT_ROUTE, taskDetailRoute, TASKS_ROUTE } from '../routes'
import { jobTitleShort, taskPhase } from '../tasks/task-model'

import { openWorkspaceArtifact } from './open-workspace-artifact'
import { useWorkspaceEvidence } from './use-workspace-evidence'
import { recentConversations, recentWorkspaceTasks } from './workspace-model'

interface WorkflowStarter {
  icon: 'globe' | 'graph' | 'megaphone'
  prompt: string
  title: string
  summary: string
}

export function ProjectsView() {
  const { t } = useI18n()
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
              <Button onClick={() => navigate(ARTIFACTS_ROUTE)} size="sm" variant="outline">
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
          <WorkspaceSection action={c.openHistory} onAction={() => navigate('/search')} title={c.recentConversations}>
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
                        : fmtDayTime.format(new Date(conversation.lastActive * 1000))}
                  </span>
                </button>
              ))
            ) : (
              <WorkspaceLimitation text={sessionsLoading ? c.loadingHistory : c.noConversations} />
            )}
            <WorkspaceLimitation text={c.toolStatusDetail} />
          </WorkspaceSection>

          <WorkspaceSection action={c.openTasks} onAction={() => navigate(TASKS_ROUTE)} title={c.taskProgress}>
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
              <WorkspaceLimitation text={c.noTasks} />
            )}
          </WorkspaceSection>

          <WorkspaceSection action={c.openArtifacts} onAction={() => navigate(ARTIFACTS_ROUTE)} title={c.deliverables}>
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
              <WorkspaceLimitation
                text={
                  evidenceUnavailable || evidence?.failedArtifactSessions
                    ? c.partialEvidence
                    : evidence
                      ? c.noArtifacts
                      : c.loadingEvidence
                }
              />
            )}
          </WorkspaceSection>

          {!evidenceUnavailable && (Boolean(evidence?.failedTasks) || Boolean(evidence?.failedArtifactSessions)) && (
            <WorkspaceLimitation text={c.partialEvidence} />
          )}
        </div>
      )}
    </section>
  )
}

function WorkspaceSection({
  action,
  children,
  onAction,
  title
}: {
  action: string
  children: ReactNode
  onAction: () => void
  title: string
}) {
  return (
    <section>
      <header className="flex items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) pb-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button onClick={onAction} size="inline" variant="textStrong">
          {action}
        </Button>
      </header>
      <div>{children}</div>
    </section>
  )
}

function WorkspaceLimitation({ text }: { text: string }) {
  return <p className="py-4 text-xs leading-5 text-muted-foreground">{text}</p>
}

export function WorkflowsView() {
  const { t } = useI18n()
  const c = t.businessWorkspace.workflows
  const navigate = useNavigate()

  const starters: WorkflowStarter[] = [
    { icon: 'globe', title: c.commerce.title, summary: c.commerce.summary, prompt: c.commerce.prompt },
    { icon: 'graph', title: c.insight.title, summary: c.insight.summary, prompt: c.insight.prompt },
    { icon: 'megaphone', title: c.content.title, summary: c.content.summary, prompt: c.content.prompt }
  ]

  const selectStarter = (starter: WorkflowStarter) => {
    navigate(NEW_CHAT_ROUTE)
    window.requestAnimationFrame(() => {
      requestComposerInsert(starter.prompt, { mode: 'block', target: 'main' })
      requestComposerFocus('main')
    })
  }

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-(--ui-chat-surface-background) px-(--page-inset-x) py-8">
      <header className="mx-auto w-full max-w-4xl border-b border-(--ui-stroke-tertiary) pb-5">
        <p className="text-xs font-medium text-primary">{c.eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{c.description}</p>
      </header>
      <div className="mx-auto grid w-full max-w-4xl gap-0 py-5 md:grid-cols-3">
        {starters.map((starter, index) => (
          <button
            className="group flex min-h-40 flex-col items-start border-b border-(--ui-stroke-tertiary) px-4 py-5 text-left hover:bg-(--chrome-action-hover) md:border-r md:border-b-0 first:pl-0 last:border-r-0"
            key={starter.title}
            onClick={() => selectStarter(starter)}
            type="button"
          >
            <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
              <Codicon name={starter.icon} size="1rem" />
            </span>
            <strong className="mt-4 text-sm">{starter.title}</strong>
            <span className="mt-1 text-xs leading-5 text-muted-foreground">{starter.summary}</span>
            <span className="mt-auto pt-4 text-xs font-medium text-primary">{c.use} →</span>
          </button>
        ))}
      </div>
    </section>
  )
}
