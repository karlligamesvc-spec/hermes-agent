import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'

import { requestComposerFocus, requestComposerInsert } from '../../chat/composer/focus'
import { useChannelStatus } from '../../chat/scenarios/use-channel-status'
import {
  IM_ENTRY_ROUTE,
  projectDetailRoute,
  PROJECTS_ROUTE,
  routeDrawerNavigationState,
  WORKFLOWS_ROUTE
} from '../../routes'
import { useWorkflowProjects } from '../hooks/use-workflow-domain-lists'
import { projectRunDisplayState } from '../view-model/project'
import { type BusinessHomeStarter, businessHomeStarters } from '../view-model/workflow-starters'

import { BusinessSection } from './business-section'
import { WorkflowStarterCard } from './workflow-starter-card'

export interface BusinessStartShelfProps {
  onSelectGoal?: (starter: BusinessHomeStarter) => void
}

/**
 * Phase 1 Start shelf. Project rows and source states come from their real
 * bridges; an unavailable project API remains an explicit lifecycle message.
 */
export function BusinessStartShelf({ onSelectGoal }: BusinessStartShelfProps = {}) {
  const { locale, t } = useI18n()
  const c = t.businessWorkspace
  const location = useLocation()
  const navigate = useNavigate()
  const starters = businessHomeStarters(c.workflows)
  const projects = useWorkflowProjects(2)
  const channelStatus = useChannelStatus()

  const sources = [
    {
      key: 'feishu',
      label: t.imEntry.channels.feishu?.name ?? 'Feishu',
      status: channelStatus.feishu
    },
    {
      key: 'weixin',
      label: t.imEntry.channels.weixin?.name ?? 'WeChat',
      status: channelStatus.weixin
    }
  ].filter(source => source.status.available)

  const selectGoal = (starter: BusinessHomeStarter) => {
    if (onSelectGoal) {
      onSelectGoal(starter)

      return
    }

    requestComposerInsert(starter.prompt, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
  }

  return (
    <div className="pointer-events-auto flex w-full flex-col gap-8 pb-10 text-left" data-business-start-shelf="">
      <section aria-labelledby="business-start-workflows">
        <header className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold" id="business-start-workflows">
              {c.workflows.homeTitle}
            </h2>
            <p className="mt-1 max-w-[48rem] text-xs leading-5 text-(--ui-text-tertiary)">
              {c.workflows.homeDescription}
            </p>
          </div>
          <Button onClick={() => navigate(WORKFLOWS_ROUTE)} size="inline" variant="textStrong">
            {c.workflows.title}
          </Button>
        </header>

        <div
          className="apex-workflow-entry-grid apex-workflow-entry-grid--stacked grid gap-2.5"
          data-start-recommended-workflows=""
        >
          {starters.map(starter => (
            <WorkflowStarterCard
              action={c.workflows.use}
              key={starter.id}
              onSelect={() => selectGoal(starter)}
              starter={starter}
              variant="shelf"
            />
          ))}
        </div>

        <p
          className="mt-3 flex max-w-[52rem] items-start gap-2 px-1 text-xs leading-5 text-(--ui-text-tertiary)"
          data-start-source-coverage=""
        >
          <Codicon className="mt-1 shrink-0 text-primary" name="globe" size="0.75rem" />
          <span>
            <strong className="font-medium text-(--ui-text-secondary)">{c.workflows.homeSourceLabel}：</strong>
            {c.workflows.homeSourceCoverage}
          </span>
        </p>
      </section>

      <div className="grid gap-8 border-t border-(--ui-stroke-tertiary) pt-6 min-[900px]:grid-cols-2">
        <BusinessSection
          action={c.projects.title}
          onAction={() => navigate(PROJECTS_ROUTE)}
          title={c.projects.recentProjects}
        >
          {projects.mode === 'loading' ? (
            <div className="flex min-h-20 items-center gap-3 text-xs text-muted-foreground">
              <Loader className="size-7" label={c.projects.loadingProjects} type="lemniscate-bloom" />
              <span>{c.projects.loadingProjects}</span>
            </div>
          ) : projects.mode === 'ready' && projects.items.length > 0 ? (
            projects.items.map(project => {
              const summary = project.summary
              const runDisplay = projectRunDisplayState(summary)

              return (
                <Button
                  className="flex h-auto w-full items-center justify-start gap-3 rounded-none border-b border-(--ui-stroke-tertiary) px-0 py-3 text-left last:border-b-0"
                  data-route-drawer-return-focus={project.id}
                  key={project.id}
                  onClick={() =>
                    navigate(projectDetailRoute(project.id), {
                      state: { ...routeDrawerNavigationState(location, project.id), businessProjectSummary: summary }
                    })
                  }
                  variant="ghost"
                >
                  <span
                    className={
                      summary?.attention === 'failed'
                        ? 'size-2 shrink-0 rounded-full bg-destructive'
                        : summary?.attention === 'review'
                          ? 'size-2 shrink-0 rounded-full bg-amber-500'
                          : summary?.currentRunStatus === 'running'
                            ? 'size-2 shrink-0 animate-pulse rounded-full bg-primary'
                            : 'size-2 shrink-0 rounded-full bg-(--ui-text-quaternary)'
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium text-foreground">{project.name}</strong>
                    <span className="mt-0.5 block truncate text-xs text-(--ui-text-tertiary)">
                      {runDisplay.kind === 'no-run'
                        ? c.projects.noRun
                        : runDisplay.kind === 'status-unavailable'
                          ? c.projects.runStatusUnavailable
                          : summary?.currentStepTitle
                            ? c.projects.currentStep(summary.currentStepTitle)
                            : summary && summary.stepTotal > 0
                              ? c.projects.steps(summary.stepCompleted, summary.stepTotal)
                              : c.projects.lifecycle(runDisplay.status)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-(--ui-text-tertiary)">
                    {formatBusinessDayTime(new Date(project.updatedAt), locale)}
                  </span>
                  <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="arrow-right" size="0.75rem" />
                </Button>
              )
            })
          ) : projects.mode === 'ready' ? (
            <p className="py-4 text-xs leading-5 text-muted-foreground">{c.projects.emptyDescription}</p>
          ) : (
            <p className="py-4 text-xs leading-5 text-muted-foreground">
              {projects.mode === 'failed' ? c.projects.projectLoadFailed : c.projects.projectDomainUnavailable}
            </p>
          )}
        </BusinessSection>

        <BusinessSection
          action={t.imEntry.manage}
          onAction={() => navigate(IM_ENTRY_ROUTE)}
          title={c.projects.availableSources}
        >
          {sources.length > 0 ? (
            sources.map(source => (
              <Button
                className="flex h-auto w-full items-center justify-between gap-3 rounded-none border-b border-(--ui-stroke-tertiary) px-0 py-3 text-left last:border-b-0"
                key={source.key}
                onClick={() => navigate(IM_ENTRY_ROUTE)}
                variant="ghost"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={
                      source.status.bound
                        ? 'size-2 shrink-0 rounded-full bg-emerald-500'
                        : 'size-2 shrink-0 rounded-full bg-(--ui-text-quaternary)'
                    }
                  />
                  <strong className="truncate text-sm font-medium text-foreground">{source.label}</strong>
                </span>
                <span className="text-xs text-(--ui-text-tertiary)">
                  {source.status.bound ? c.projects.sourceConnected : c.projects.sourceNotConnected}
                </span>
              </Button>
            ))
          ) : (
            <p className="py-4 text-xs leading-5 text-muted-foreground">{c.projects.noAvailableSources}</p>
          )}
        </BusinessSection>
      </div>
    </div>
  )
}
