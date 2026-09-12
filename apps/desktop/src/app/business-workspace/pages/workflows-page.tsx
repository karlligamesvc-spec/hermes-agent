import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import { NEW_CHAT_ROUTE, projectDetailRoute, routeDrawerNavigationState } from '../../routes'
import { BusinessPageHeader } from '../components/business-page-header'
import { WorkflowStarterCard } from '../components/workflow-starter-card'
import { useWorkflowCatalog, useWorkflowDefinitions } from '../hooks/use-workflow-domain-lists'
import { type BusinessWorkflowStarter, businessWorkflowStarters } from '../view-model/workflow-starters'

export function WorkflowsView() {
  const { t } = useI18n()
  const c = t.businessWorkspace.workflows
  const location = useLocation()
  const navigate = useNavigate()
  const [reloadToken, setReloadToken] = useState(0)
  const catalog = useWorkflowCatalog(reloadToken)
  const workflows = useWorkflowDefinitions({ limit: 50 }, reloadToken)
  const localStarters = businessWorkflowStarters(c)
  const launchContext = location.state as null | { businessGoalDraft?: unknown; businessProjectId?: unknown }

  const targetProjectId =
    typeof launchContext?.businessProjectId === 'string' ? launchContext.businessProjectId.trim() : ''

  const targetObjective =
    typeof launchContext?.businessGoalDraft === 'string' ? launchContext.businessGoalDraft.slice(0, 4000) : ''

  const starters =
    catalog.mode === 'ready'
      ? catalog.items
          .slice()
          .sort((left, right) => left.position - right.position)
          .flatMap(item => {
            const local = localStarters.find(starter => starter.id === item.id && starter.slug === item.slug)

            return local
              ? [{ ...local, businessPath: item.businessPath, recommended: item.recommended, version: item.version }]
              : []
          })
      : []

  const testCatalog = catalog.mode === 'ready' && /(?:local|test|staging|review)/i.test(catalog.version ?? '')

  const recommended = starters.filter(starter => starter.recommended)
  const additional = starters.filter(starter => !starter.recommended)

  const selectStarter = (starter: BusinessWorkflowStarter) => {
    navigate(NEW_CHAT_ROUTE, {
      state: {
        businessGoalDraft: targetObjective || starter.prompt,
        ...(targetProjectId ? { businessProjectId: targetProjectId } : {}),
        businessWorkflowCatalogProvenance: testCatalog ? 'test' : 'production',
        businessWorkflowId: starter.id,
        businessWorkflowVersion: starter.version,
        businessWorkflowSlug: starter.slug
      }
    })
  }

  return (
    <section className="apex-business-surface apex-business-page apex-primary-page" data-business-workflows-page="">
      <div className="apex-primary-page-column">
        <BusinessPageHeader
          action={{
            icon: 'play',
            label: c.startGoal,
            onClick: () => navigate(NEW_CHAT_ROUTE, { state: { businessGoalFocus: true } })
          }}
          description={c.description}
          eyebrow={c.eyebrow}
          icon="list-unordered"
          title={c.title}
          trailing={
            testCatalog ? (
              <p
                className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
                role="status"
              >
                {c.testDataNotice}
              </p>
            ) : undefined
          }
        />
      </div>
      <section
        className="mx-auto w-full max-w-[65.625rem] border-b border-(--ui-stroke-tertiary) py-6"
        data-saved-workflows=""
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{c.savedTitle}</h2>
            {targetProjectId && <p className="mt-1 text-xs text-muted-foreground">{c.addingToProject}</p>}
          </div>
          {workflows.mode === 'ready' && (
            <span className="text-xs text-(--ui-text-tertiary)">{c.savedCount(workflows.items.length)}</span>
          )}
        </div>
        {workflows.mode === 'loading' ? (
          <div className="mt-4 flex min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader className="size-6" label={c.loadingSaved} type="lemniscate-bloom" />
            {c.loadingSaved}
          </div>
        ) : workflows.mode === 'ready' && workflows.items.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) shadow-xs">
            {workflows.items.map(workflow => (
              <Button
                className="flex min-h-16 w-full items-center justify-between gap-4 rounded-none border-b border-(--ui-stroke-tertiary) px-4 py-3 text-left last:border-b-0"
                key={workflow.id}
                onClick={() =>
                  navigate(projectDetailRoute(workflow.projectId), {
                    state: routeDrawerNavigationState(location)
                  })
                }
                variant="ghost"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium">{workflow.name}</strong>
                  <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                    {workflow.description || workflow.slug}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-(--ui-text-tertiary)">
                  {workflow.version ? <span>{c.version(workflow.version)}</span> : null}
                  {t.businessWorkspace.projects.lifecycle(workflow.status)}
                  <Codicon name="arrow-right" size="0.75rem" />
                </span>
              </Button>
            ))}
          </div>
        ) : workflows.mode === 'ready' ? (
          <p className="mt-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-5 text-xs text-muted-foreground">
            {c.savedEmpty}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/45 bg-amber-50/40 px-4 py-4 text-xs text-amber-800 dark:bg-amber-950/15 dark:text-amber-200">
            <span>{c.savedUnavailable}</span>
            <Button
              aria-label={`${c.retryCatalog} · ${c.savedTitle}`}
              onClick={() => setReloadToken(token => token + 1)}
              size="sm"
              variant="outline"
            >
              <Codicon name="refresh" size="0.875rem" />
              {c.retryCatalog}
            </Button>
          </div>
        )}
      </section>
      {catalog.mode === 'loading' ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={c.title} type="lemniscate-bloom" />
          <span>{c.title}</span>
        </div>
      ) : catalog.mode !== 'ready' ? (
        <div
          className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center"
          data-workflow-recovery=""
        >
          <div>
            <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
            <EmptyState
              description={catalog.mode === 'unavailable' ? c.localCatalogNotice : c.catalogUnavailableDescription}
              title={c.catalogUnavailable}
            />
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setReloadToken(token => token + 1)} size="sm">
                <Codicon name="refresh" size="0.875rem" />
                {c.retryCatalog}
              </Button>
              <Button onClick={() => navigate(NEW_CHAT_ROUTE)} size="sm" variant="ghost">
                {c.backToStart}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="mx-auto w-full max-w-[65.625rem] py-5">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">{c.recommendedTitle}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{c.recommendedDescription}</p>
              </div>
              <span className="text-xs text-(--ui-text-tertiary)">{c.pathCount(recommended.length)}</span>
            </div>
            <div className="apex-workflow-entry-grid grid gap-1" data-recommended-workflows="">
              {recommended.map(starter => (
                <WorkflowStarterCard
                  action={c.use}
                  key={starter.id}
                  onSelect={() => selectStarter(starter)}
                  starter={starter}
                  variant="featured"
                />
              ))}
            </div>

            <div className="mb-4 mt-7 flex items-center justify-between gap-4 border-t border-(--ui-stroke-tertiary) pt-6">
              <h2 className="text-base font-semibold">{c.additionalTitle}</h2>
              <span className="text-xs text-(--ui-text-tertiary)">{c.pathCount(additional.length)}</span>
            </div>
            <div
              className="grid grid-cols-1 gap-3 min-[760px]:grid-cols-2 min-[1100px]:grid-cols-3"
              data-additional-workflows=""
            >
              {additional.map(starter => (
                <WorkflowStarterCard
                  action={c.useShort}
                  key={starter.id}
                  onSelect={() => selectStarter(starter)}
                  starter={starter}
                  variant="compact"
                />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
