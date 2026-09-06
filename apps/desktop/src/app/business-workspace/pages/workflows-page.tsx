import { useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import { NEW_CHAT_ROUTE } from '../../routes'
import { BusinessPageHeader } from '../components/business-page-header'
import { WorkflowStarterCard } from '../components/workflow-starter-card'
import { useWorkflowDefinitions } from '../hooks/use-workflow-domain-lists'
import { type BusinessWorkflowStarter, businessWorkflowStarters } from '../view-model/workflow-starters'

export function WorkflowsView() {
  const { t } = useI18n()
  const c = t.businessWorkspace.workflows
  const navigate = useNavigate()
  const [reloadToken, setReloadToken] = useState(0)
  const result = useWorkflowDefinitions(reloadToken)
  const localStarters = businessWorkflowStarters(c)

  const starters =
    result.mode === 'ready'
      ? result.catalog
          .slice()
          .sort((left, right) => left.position - right.position)
          .flatMap(item => {
            const local = localStarters.find(starter => starter.id === item.id && starter.slug === item.slug)

            return local
              ? [{ ...local, businessPath: item.businessPath, recommended: item.recommended, version: item.version }]
              : []
          })
      : []

  const testCatalog = result.mode === 'ready' && /(?:local|test|staging|review)/i.test(result.catalogVersion ?? '')

  const recommended = starters.filter(starter => starter.recommended)
  const additional = starters.filter(starter => !starter.recommended)

  const selectStarter = (starter: BusinessWorkflowStarter) => {
    navigate(NEW_CHAT_ROUTE, {
      state: {
        businessGoalDraft: starter.prompt,
        businessWorkflowId: starter.id,
        businessWorkflowVersion: starter.version,
        businessWorkflowSlug: starter.slug
      }
    })
  }

  return (
    <section
      className="h-full overflow-y-auto bg-(--ui-chat-surface-background) px-6 py-8 min-[1100px]:px-9"
      data-business-workflows-page=""
    >
      <div className="mx-auto w-full max-w-[65.625rem]">
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
              <p className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-200" role="status">
                {c.testDataNotice}
              </p>
            ) : undefined
          }
        />
      </div>
      {result.mode === 'loading' ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={c.title} type="lemniscate-bloom" />
          <span>{c.title}</span>
        </div>
      ) : result.mode !== 'ready' ? (
        <div className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center" data-workflow-recovery="">
          <div>
            <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
            <EmptyState
              description={result.mode === 'unavailable' ? c.localCatalogNotice : c.catalogUnavailableDescription}
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
          <div className="mx-auto w-full max-w-[65.625rem] py-6">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">{c.recommendedTitle}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{c.recommendedDescription}</p>
              </div>
              <span className="text-xs text-(--ui-text-tertiary)">{c.pathCount(recommended.length)}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 min-[820px]:grid-cols-3" data-recommended-workflows="">
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

            <div className="mb-4 mt-8 flex items-center justify-between gap-4 border-t border-(--ui-stroke-tertiary) pt-6">
              <h2 className="text-base font-semibold">{c.additionalTitle}</h2>
              <span className="text-xs text-(--ui-text-tertiary)">{c.pathCount(additional.length)}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-3" data-additional-workflows="">
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
      {result.mode === 'ready' && (
        <section className="mx-auto w-full max-w-[65.625rem] border-t border-(--ui-stroke-tertiary) py-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold">{c.savedTitle}</h2>
            <span className="text-xs text-(--ui-text-tertiary)">{c.savedCount(result.items.length)}</span>
          </div>
          {result.items.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated)">
              {result.items.map(workflow => (
                <div
                  className="flex items-start justify-between gap-4 border-b border-(--ui-stroke-tertiary) px-4 py-3 last:border-b-0"
                  key={workflow.id}
                >
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{workflow.name}</strong>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {workflow.description || workflow.slug}
                    </span>
                  </span>
                  {workflow.version !== null && (
                    <span className="shrink-0 text-xs text-(--ui-text-tertiary)">{c.version(workflow.version)}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-5 text-xs text-muted-foreground">
              {c.savedEmpty}
            </p>
          )}
        </section>
      )}
    </section>
  )
}
