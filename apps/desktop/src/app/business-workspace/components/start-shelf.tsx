import { useLocation, useNavigate } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'

import { requestComposerFocus, requestComposerInsert } from '../../chat/composer/focus'
import { useChannelStatus } from '../../chat/scenarios/use-channel-status'
import { IM_ENTRY_ROUTE, projectDetailRoute, PROJECTS_ROUTE, routeDrawerNavigationState, WORKFLOWS_ROUTE } from '../../routes'
import { useWorkflowCatalog, useWorkflowProjects } from '../hooks/use-workflow-domain-lists'
import { projectRunDisplayState } from '../view-model/project'
import { type BusinessHomeStarter, businessHomeStarters, type BusinessWorkflowStarter, businessWorkflowStarters } from '../view-model/workflow-starters'

import { WorkflowRefreshNotice } from './workflow-refresh-notice'
import { WorkflowStarterCard } from './workflow-starter-card'

export interface BusinessStartShelfProps {
  onSelectGoal?: (starter: BusinessHomeStarter) => void
  onSelectWorkflow?: (starter: BusinessWorkflowStarter, testCatalog: boolean) => void
  selectedWorkflowId?: string
  selectionDisabled?: boolean
}

/**
 * Phase 1 Start shelf. Project rows and source states come from their real
 * bridges; an unavailable project API remains an explicit lifecycle message.
 */
export function BusinessStartShelf({ onSelectGoal, onSelectWorkflow, selectedWorkflowId, selectionDisabled = false }: BusinessStartShelfProps = {}) {
  const { locale, t } = useI18n()
  const c = t.businessWorkspace
  const location = useLocation()
  const navigate = useNavigate()
  const starters = businessHomeStarters(c.workflows)
  const catalog = useWorkflowCatalog()

  const primaryCopy: Record<string, { title: string; summary: string; prompt: string }> = {
    'market-launch': t.home.primaryPaths.commerce,
    'geo-brand-audit': t.home.primaryPaths.geo,
    'content-review': t.home.primaryPaths.content
  }

  const primaryStarters = businessWorkflowStarters(c.workflows)
    .filter(starter => primaryCopy[starter.id])
    .map(starter => ({ ...starter, ...primaryCopy[starter.id] }))

  const testCatalog = catalog.mode === 'ready' && /(?:local|test|staging|review)/i.test(catalog.version ?? '')

  const primaryAvailable = catalog.mode === 'ready' && primaryStarters.every(starter => catalog.items.some(item => item.id === starter.id && item.slug === starter.slug))
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
    if (selectionDisabled) {return}

    if (onSelectGoal) {
      onSelectGoal(starter)

      return
    }

    requestComposerInsert(starter.prompt, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
  }

  const selectWorkflow = (starter: BusinessWorkflowStarter) => {
    if (selectionDisabled) {return}

    if (onSelectWorkflow) {
      onSelectWorkflow(starter, testCatalog)

      return
    }

    navigate(WORKFLOWS_ROUTE, { state: { businessStartSelection: true, businessGoalDraft: starter.prompt } })
  }

  return (
    <div className="apex-start-shelf pointer-events-auto w-full text-left" data-business-start-shelf="">
      <section aria-labelledby="business-start-workflows">
        <header className="apex-start-section-heading">
          <div>
            <p>{t.home.pathsEyebrow}</p>
            <h2 id="business-start-workflows">
              {t.home.pathsTitle}
            </h2>
          </div>
          <Button disabled={selectionDisabled} onClick={() => { if (!selectionDisabled) {navigate(WORKFLOWS_ROUTE)} }} size="inline" variant="text">
            {c.workflows.title}<Codicon name="arrow-right" size="0.75rem" />
          </Button>
        </header>

        <div className="apex-start-primary-grid" data-start-primary-workflows="">
          {primaryStarters.map(starter => {
            const item = catalog.mode === 'ready' ? catalog.items.find(row => row.id === starter.id && row.slug === starter.slug) : null

            return (
              <Button
                aria-label={`${starter.title} · ${c.workflows.use}`}
                aria-pressed={selectedWorkflowId === starter.id}
                className="apex-start-primary-card"
                disabled={!item || selectionDisabled}
                key={starter.id}
                onClick={() => {
                  if (item) {
                    selectWorkflow({ ...starter, businessPath: item.businessPath, version: item.version })
                  }
                }}
                size="inline"
                type="button"
                variant="ghost"
              >
                <img alt="" height={86} src={`${import.meta.env.BASE_URL}assets/workflow-${starter.id === 'market-launch' ? 'commerce' : starter.id === 'geo-brand-audit' ? 'geo' : 'content'}-minimal.png`} width={86} />
                <span><strong>{starter.title}</strong><small>{starter.summary}</small></span>
              </Button>
            )
          })}
        </div>
        {!primaryAvailable && <p className="apex-start-catalog-status" role="status">
          {catalog.mode === 'loading' ? t.home.catalogLoading : c.workflows.catalogUnavailable}
        </p>}
      </section>

      <section aria-labelledby="business-start-capability-goals" className="apex-start-secondary-paths">
        <h2 id="business-start-capability-goals">{t.home.capabilityPaths}</h2>
        <div className="apex-start-secondary-grid" data-start-recommended-workflows="">
          {starters.map(starter => (
            <WorkflowStarterCard
              action={c.workflows.use}
              disabled={selectionDisabled}
              key={starter.id}
              onSelect={() => selectGoal(starter)}
              starter={starter}
              variant="shelf"
            />
          ))}
        </div>

      </section>

      <div className="apex-start-overview" data-start-workspace-overview="">
        <section aria-labelledby="business-start-recent-projects" className="apex-start-recent">
          <header className="apex-start-section-heading"><h2 id="business-start-recent-projects">{c.projects.recentProjects}</h2></header>
          <WorkflowRefreshNotice state={projects} />
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
                  data-start-recent-project=""
                  key={project.id}
                  onClick={() =>
                    navigate(projectDetailRoute(project.id), {
                      state: { ...routeDrawerNavigationState(location, project.id), businessProjectSummary: summary }
                    })
                  }
                  variant="ghost"
                >
                  <span className="apex-start-project-icon"><Codicon name="folder" size="1.25rem" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <strong className="truncate text-sm font-medium text-foreground">{project.name}</strong>
                      <Badge variant="muted">{c.projects.lifecycle(project.status)}</Badge>
                    </span>
                    <span className="mt-0.5 block text-xs text-(--ui-text-tertiary)">
                      <time dateTime={project.updatedAt}>{c.projects.updatedAt(formatBusinessDayTime(new Date(project.updatedAt), locale))}</time>
                      {' · '}
                      <span>{runDisplay.kind === 'no-run'
                        ? c.projects.noRun
                        : runDisplay.kind === 'status-unavailable'
                          ? c.projects.runStatusUnavailable
                          : c.projects.runLifecycle(runDisplay.status)}</span>
                    </span>
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
          <Button onClick={() => navigate(PROJECTS_ROUTE)} size="inline" variant="text">{c.projects.title}<Codicon name="arrow-right" size="0.75rem" /></Button>
        </section>

        <section aria-labelledby="business-start-connections" className="apex-start-connections">
          <header className="apex-start-section-heading"><h2 id="business-start-connections">{c.projects.availableSources}</h2>
            <Button onClick={() => navigate(IM_ENTRY_ROUTE)} size="inline" variant="text">{t.imEntry.manage}</Button>
          </header>
          <div className="apex-start-connection-grid">
          {sources.length > 0 ? (
            sources.map(source => (
              <Button
                className="apex-start-connection"
                key={source.key}
                onClick={() => navigate(IM_ENTRY_ROUTE)}
                size="inline"
                variant="ghost"
              >
                <span className="apex-start-connection-icon"><Codicon name="comment-discussion" size="1.25rem" /></span>
                <strong>{source.label}</strong>
                <span className="text-xs text-(--ui-text-tertiary)">
                  {source.status.bound ? c.projects.sourceConnected : c.projects.sourceNotConnected}
                </span>
              </Button>
            ))
          ) : (
            <p className="py-4 text-xs leading-5 text-muted-foreground">{c.projects.noAvailableSources}</p>
          )}
          </div>
          <p className="apex-start-source-coverage" data-start-source-coverage="">
            <Codicon name="globe" size="0.75rem" />
            <span><strong>{c.workflows.homeSourceLabel}：</strong>{c.workflows.homeSourceCoverage}</span>
          </p>
        </section>
      </div>
    </div>
  )
}
