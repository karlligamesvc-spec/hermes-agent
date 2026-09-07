import { useNavigate } from 'react-router'

import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import { NEW_CHAT_ROUTE } from '../../routes'
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
        businessWorkflowSlug: starter.slug
      }
    })
  }

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-(--ui-chat-surface-background) px-(--page-inset-x) py-8">
      <header className="mx-auto w-full max-w-4xl border-b border-(--ui-stroke-tertiary) pb-5">
        <p className="text-xs font-medium text-primary">{c.eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{c.description}</p>
      </header>
      {result.mode === 'loading' ? (
        <div className="mx-auto flex w-full max-w-4xl flex-1 items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={c.title} type="lemniscate-bloom" />
          <span>{c.title}</span>
        </div>
      ) : result.mode === 'failed' ? (
        <p className="mx-auto w-full max-w-4xl py-8 text-sm text-amber-600" role="alert">
          {c.catalogUnavailable}
        </p>
      ) : (
        <>
          <div className="mx-auto grid w-full max-w-4xl gap-0 py-5 md:grid-cols-3">
            {recommended.map(starter => (
              <button
                className="group flex min-h-40 flex-col items-start border-b border-(--ui-stroke-tertiary) px-4 py-5 text-left hover:bg-(--chrome-action-hover) md:border-r md:border-b-0 first:pl-0 last:border-r-0"
                key={starter.id}
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
          <div className="mx-auto grid w-full max-w-4xl border-t border-(--ui-stroke-tertiary)">
            {additional.map(starter => (
              <button
                className="flex items-center gap-3 border-b border-(--ui-stroke-tertiary) py-4 text-left hover:bg-(--chrome-action-hover)"
                key={starter.id}
                onClick={() => selectStarter(starter)}
                type="button"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <Codicon name={starter.icon} size="0.875rem" />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">{starter.title}</strong>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{starter.summary}</span>
                </span>
                <span className="text-xs font-medium text-primary">{c.use} →</span>
              </button>
            ))}
          </div>
        </>
      )}
      {result.mode === 'ready' && (
        <section className="mx-auto w-full max-w-4xl border-t border-(--ui-stroke-tertiary) py-6">
          <h2 className="text-sm font-semibold">{c.savedTitle}</h2>
          {result.items.length > 0 ? (
            <div className="mt-3 grid gap-0">
              {result.items.map(workflow => (
                <div
                  className="flex items-start justify-between gap-4 border-b border-(--ui-stroke-tertiary) py-3"
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
            <p className="mt-3 text-xs text-muted-foreground">{c.savedEmpty}</p>
          )}
        </section>
      )}
    </section>
  )
}
