import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'

import { deliverableDetailRoute, routeDrawerNavigationState } from '../../routes'
import type { WorkflowDeliverable } from '../api/types'
import { BusinessPageHeader } from '../components/business-page-header'
import { useWorkflowDeliverables } from '../hooks/use-workflow-deliverables'

type DeliverableFilter = 'all' | 'copy' | 'material' | 'report' | 'sheet'

function kindGroup(kind: string): Exclude<DeliverableFilter, 'all'> | 'other' {
  const normalized = kind.toLowerCase()

  if (/(sheet|spreadsheet|xlsx|csv|table)/.test(normalized)) {
    return 'sheet'
  }

  if (/(copy|content|text|markdown|article)/.test(normalized)) {
    return 'copy'
  }

  if (/(image|video|audio|media|asset|material)/.test(normalized)) {
    return 'material'
  }

  if (/(report|research|analysis|brief)/.test(normalized)) {
    return 'report'
  }

  return 'other'
}

function deliverableSummary(item: WorkflowDeliverable): string {
  return item.payload.summary || item.payload.content || item.payload.filename || ''
}

export function DeliverablesView() {
  const { locale, t } = useI18n()
  const copy = t.businessWorkspace.workflowDomain.deliverables
  const location = useLocation()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<DeliverableFilter>('all')
  const { loadMore, refresh, state } = useWorkflowDeliverables()

  const visibleItems = useMemo(
    () =>
      state.mode === 'ready' ? state.items.filter(item => filter === 'all' || kindGroup(item.kind) === filter) : [],
    [filter, state]
  )

  return (
    <section className="apex-business-surface apex-business-page apex-primary-page" data-deliverables-page="">
      <div className="apex-primary-page-column">
        <BusinessPageHeader
          action={{ icon: 'refresh', label: copy.refresh, onClick: refresh }}
          description={copy.description}
          eyebrow={copy.detailEyebrow}
          icon="files"
          title={copy.title}
        />
      </div>

      {state.mode === 'loading' ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={copy.loading} type="lemniscate-bloom" />
          <span>{copy.loading}</span>
        </div>
      ) : state.mode === 'unavailable' || state.mode === 'failed' ? (
        <div className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center">
          <div>
            <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
            <EmptyState
              description={state.mode === 'unavailable' ? copy.unavailableDescription : copy.loadFailedDescription}
              title={state.mode === 'unavailable' ? copy.unavailableTitle : copy.loadFailedTitle}
            />
            <Button onClick={refresh} size="sm">
              <Codicon name="refresh" />
              {copy.refresh}
            </Button>
          </div>
        </div>
      ) : state.items.length === 0 ? (
        <div className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center">
          <div>
            <Codicon className="mx-auto text-primary" name="files" size="1.75rem" />
            <EmptyState description={copy.emptyDescription} title={copy.emptyTitle} />
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[65.625rem] py-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div aria-label={copy.filters} role="group">
              <SegmentedControl
                onChange={setFilter}
                options={(['all', 'report', 'sheet', 'copy', 'material'] as const).map(id => ({
                  id,
                  label: copy[id]
                }))}
                value={filter}
              />
            </div>
            <span className="text-xs text-(--ui-text-tertiary)">{copy.itemCount(state.items.length)}</span>
          </div>

          {visibleItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{copy.filterEmpty}</div>
          ) : (
            <div className="space-y-1">
              {visibleItems.map(item => {
                const summary = deliverableSummary(item)
                const openerKey = `deliverable:${item.id}`

                return (
                  <Button
                    className="grid min-h-[6.25rem] w-full grid-cols-[auto_minmax(0,1fr)] gap-4 text-left sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                    data-route-drawer-return-focus={openerKey}
                    key={item.id}
                    onClick={() =>
                      navigate(deliverableDetailRoute(item.id), {
                        state: routeDrawerNavigationState(location, openerKey)
                      })
                    }
                    variant="ghost"
                  >
                    <span className="grid size-11 shrink-0 place-items-center self-center rounded-xl bg-primary/10 text-primary">
                      <Codicon name="file" size="1.125rem" />
                    </span>
                    <span className="min-w-0 self-center">
                      <span className="flex flex-wrap items-center gap-2">
                        <strong className="truncate text-sm font-semibold">{item.title}</strong>
                        <Badge
                          variant={
                            item.status === 'approved'
                              ? 'default'
                              : item.status === 'changes_requested'
                                ? 'warn'
                                : 'muted'
                          }
                        >
                          {copy.status(item.status)}
                        </Badge>
                        <Badge variant="outline">{copy.kind(item.kind)}</Badge>
                      </span>
                      {summary && (
                        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                          {summary}
                        </span>
                      )}
                    </span>
                    <span className="col-span-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 self-center pl-[3.75rem] text-xs text-(--ui-text-tertiary) sm:col-span-1 sm:pl-0">
                      <span>{copy.evidenceCount(item.evidence.length)}</span>
                      <span>{formatBusinessDayTime(new Date(item.updatedAt), locale)}</span>
                      <span>{copy.view}</span>
                      <Codicon name="arrow-right" />
                    </span>
                  </Button>
                )
              })}
            </div>
          )}

          {state.nextCursor && (
            <div className="flex justify-center py-5">
              <Button disabled={state.loadingMore} onClick={() => void loadMore()} size="sm" variant="outline">
                {state.loadingMore ? copy.loadingMore : copy.loadMore}
              </Button>
            </div>
          )}
          {state.moreFailed && (
            <p className="pb-4 text-center text-xs text-destructive">{copy.loadFailedDescription}</p>
          )}
        </div>
      )}
    </section>
  )
}
