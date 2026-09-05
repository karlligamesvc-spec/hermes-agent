import { useNavigate } from 'react-router'

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
  const result = useWorkflowDefinitions()
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
      : result.mode === 'unavailable'
        ? localStarters
        : []

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
            result.mode === 'unavailable' ? (
              <p className="mt-3 text-xs text-(--ui-text-tertiary)">{c.localCatalogNotice}</p>
            ) : undefined
          }
        />
      </div>
      {result.mode === 'loading' ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={c.title} type="lemniscate-bloom" />
          <span>{c.title}</span>
        </div>
      ) : result.mode === 'failed' ? (
        <p className="mx-auto w-full max-w-[65.625rem] py-8 text-sm text-amber-600" role="alert">
          {c.catalogUnavailable}
        </p>
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
