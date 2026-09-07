import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { formatBusinessDayTime } from '@/lib/time'
import { openPreview } from '@/store/preview'

import type { WorkflowRunOverview } from '../api/types'
import { RunFact, RunSection } from '../components/run-sections'
import { useWorkflowRun } from '../hooks/use-workflow-run'
import { businessStatusPresentation, businessStatusToneClass } from '../view-model/display-status'

type RunDeliverable = WorkflowRunOverview['deliverables'][number]

export function WorkflowRunView() {
  const { locale, t } = useI18n()
  const copy = t.businessWorkspace.workflowDomain.run
  const { runId = '' } = useParams()
  const { actionFailed, actionId, cancel, failed, load, loading, overview, review } = useWorkflowRun(runId)
  const [openingId, setOpeningId] = useState<null | string>(null)
  const [openFailedId, setOpenFailedId] = useState<null | string>(null)
  const [activeView, setActiveView] = useState('progress')
  const scrollRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setActiveView('progress')

    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [runId])

  const openDeliverable = async (deliverable: RunDeliverable) => {
    if (!deliverable.openReference) {
      return
    }

    setOpenFailedId(null)
    setOpeningId(deliverable.id)

    try {
      const target = await normalizeOrLocalPreviewTarget(deliverable.openReference)

      if (!target) {
        setOpenFailedId(deliverable.id)

        return
      }

      openPreview({ ...target, label: deliverable.title }, 'explicit-link')
    } catch {
      setOpenFailedId(deliverable.id)
    } finally {
      setOpeningId(null)
    }
  }

  if (loading && !overview) {
    return (
      <div className="grid h-full place-items-center bg-(--ui-chat-surface-background)">
        <Loader label={copy.loading} type="lemniscate-bloom" />
      </div>
    )
  }

  if (!overview) {
    return (
      <div
        className={`grid h-full place-items-center bg-(--ui-chat-surface-background) ${PAGE_INSET_X}`}
        data-run-error-container=""
      >
        <ErrorState description={copy.loadFailedDescription} title={copy.loadFailedTitle}>
          <Button onClick={() => void load()} size="sm" variant="outline">
            <Codicon name="refresh" />
            {copy.retry}
          </Button>
        </ErrorState>
      </div>
    )
  }

  const { deliverables, events, run } = overview
  const runPresentation = businessStatusPresentation('run', run.status)
  const canCancel = runPresentation.canCancel
  const waitingForReview = runPresentation.canonical === 'waiting_review'

  const pendingReviewCount = waitingForReview
    ? deliverables.filter(deliverable => {
        const status = deliverable.reviews.at(-1)?.status || deliverable.status

        return status !== 'approved' && status !== 'rejected'
      }).length
    : 0

  const pendingDeliverables = waitingForReview
    ? deliverables.filter(deliverable => {
        const status = deliverable.reviews.at(-1)?.status || deliverable.status

        return status !== 'approved' && status !== 'rejected'
      })
    : []

  const otherDeliverables = deliverables.filter(
    deliverable => !pendingDeliverables.some(pending => pending.id === deliverable.id)
  )

  const selectView = (value: string) => {
    setActiveView(value)

    if (value === 'progress' && scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }

  const renderDeliverable = (deliverable: RunDeliverable, canReview: boolean) => {
    const latestReview = deliverable.reviews.at(-1)
    const displayedStatus = latestReview?.status || deliverable.status
    const reviewBusy = actionId?.startsWith(`${deliverable.id}:`) ?? false

    return (
      <article className="border-b border-(--ui-stroke-tertiary) py-4 last:border-b-0" key={deliverable.id}>
        <div className="flex items-start gap-3">
          <Codicon className="mt-0.5 shrink-0 text-primary" name="file" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{deliverable.title}</h3>
              <span
                className={`text-xs ${businessStatusToneClass(
                  businessStatusPresentation('deliverable', displayedStatus).tone
                )}`}
              >
                {copy.status(displayedStatus)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {copy.evidence(deliverable.evidenceCount)} · {deliverable.kind}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {canReview && (
                <Button disabled={reviewBusy} onClick={() => void review(deliverable.id, 'approved')} size="sm">
                  <Codicon name="check" />
                  {copy.approve}
                </Button>
              )}
              <Button
                disabled={!deliverable.openReference || openingId !== null}
                onClick={() => void openDeliverable(deliverable)}
                size="sm"
                variant="outline"
              >
                <Codicon name="link-external" />
                {openingId === deliverable.id
                  ? copy.openingDeliverable
                  : deliverable.openReference
                    ? copy.openDeliverable
                    : copy.openUnavailable}
              </Button>
              {canReview && (
                <Button
                  disabled={reviewBusy}
                  onClick={() => void review(deliverable.id, 'changes_requested')}
                  size="sm"
                  variant="outline"
                >
                  <Codicon name="edit" />
                  {copy.requestChanges}
                </Button>
              )}
            </div>
            {openFailedId === deliverable.id && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {copy.openFailed}
              </p>
            )}
          </div>
        </div>
      </article>
    )
  }

  return (
    <section
      className={`h-full overflow-y-auto bg-(--ui-chat-surface-background) py-8 ${PAGE_INSET_X}`}
      data-route-drawer-scroll=""
      data-run-scroll-container=""
      ref={scrollRef}
    >
      <div className="mx-auto w-full max-w-4xl pb-10">
        <header className="flex items-start justify-between gap-5 border-b border-(--ui-stroke-tertiary) pb-5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-primary">{copy.eyebrow}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{copy.title}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {run.triggerRef || copy.noObjective}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className={`text-xs font-medium ${businessStatusToneClass(runPresentation.tone)}`}>
              {copy.status(runPresentation.canonical)}
            </span>
            {canCancel && (
              <Button disabled={actionId !== null} onClick={() => void cancel()} size="sm" variant="outline">
                <Codicon name="debug-stop" />
                {actionId === 'cancel' ? copy.cancelling : copy.cancel}
              </Button>
            )}
          </div>
        </header>

        {actionFailed && (
          <p className="mt-4 text-xs text-destructive" role="alert">
            {copy.actionFailed}
          </p>
        )}

        {failed && (
          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) pb-4 text-xs text-(--ui-text-secondary)"
            role="status"
          >
            <span>{copy.refreshFailedDescription}</span>
            <Button onClick={() => void load()} size="xs" variant="textStrong">
              {copy.refresh}
            </Button>
          </div>
        )}

        <dl className="mt-6 grid gap-4 border-b border-(--ui-stroke-tertiary) pb-6 sm:grid-cols-3">
          <RunFact
            label={copy.executor}
            value={run.executorType === 'hermes' ? copy.hermesExecutor : copy.executorUnavailable}
          />
          <RunFact
            label={copy.started}
            value={formatBusinessDayTime(new Date(run.startedAt || run.createdAt), locale)}
          />
          <RunFact label={copy.updated} value={formatBusinessDayTime(new Date(run.updatedAt), locale)} />
        </dl>

        <Tabs className="mt-6 gap-0" onValueChange={selectView} value={activeView}>
          <TabsList aria-label={copy.viewTabs}>
            <TabsTrigger value="progress">{copy.progressTab}</TabsTrigger>
            <TabsTrigger value="details">{copy.detailsTab}</TabsTrigger>
          </TabsList>

          <TabsContent value="progress">
            {pendingReviewCount > 0 && (
              <RunSection title={copy.pendingReviewTitle}>
                <p className="pt-4 text-sm text-(--ui-text-secondary)">
                  {copy.pendingReviewDescription(pendingReviewCount)}
                </p>
                {pendingDeliverables.map(deliverable => renderDeliverable(deliverable, true))}
              </RunSection>
            )}

            <RunSection title={copy.stageProgress}>
              <div className="py-4" data-stage-empty-state="compact">
                <p className="text-sm font-medium">{copy.noStageProgressTitle}</p>
                <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">{copy.noStageProgressDescription}</p>
              </div>
            </RunSection>

            {pendingReviewCount === 0 && (
              <RunSection title={copy.pendingReviewTitle}>
                <div className="py-4">
                  <p className="text-sm font-medium">{copy.noPendingTitle}</p>
                  <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">{copy.noPendingDescription}</p>
                </div>
              </RunSection>
            )}

            {(otherDeliverables.length > 0 || deliverables.length === 0) && (
              <RunSection title={copy.deliverables}>
                {otherDeliverables.length > 0 ? (
                  otherDeliverables.map(deliverable => renderDeliverable(deliverable, false))
                ) : (
                  <EmptyState description={copy.noDeliverablesDescription} title={copy.noDeliverablesTitle} />
                )}
              </RunSection>
            )}
          </TabsContent>

          <TabsContent value="details">
            <dl className="mt-8 grid gap-4 border-b border-(--ui-stroke-tertiary) pb-6 sm:grid-cols-2">
              <RunFact label={copy.attempt} value={copy.attemptDescription(run.attempt, run.maxAttempts)} />
              <RunFact label={copy.created} value={formatBusinessDayTime(new Date(run.createdAt), locale)} />
            </dl>

            <RunSection title={copy.events}>
              {events.length ? (
                events.map(event => (
                  <div
                    className="flex items-start gap-3 border-b border-(--ui-stroke-tertiary) py-3 last:border-b-0"
                    key={event.id}
                  >
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{copy.event(event.eventType)}</p>
                      <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">
                        {copy.eventSummary(event.eventType)}
                      </p>
                      <p className="mt-1 text-xs text-(--ui-text-tertiary)">
                        #{event.sequence} · {formatBusinessDayTime(new Date(event.happenedAt), locale)}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState description={copy.noEvents} title={copy.waitingForEvents} />
              )}
            </RunSection>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  )
}
