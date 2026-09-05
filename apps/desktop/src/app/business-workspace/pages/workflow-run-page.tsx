import { useParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { fmtDayTime } from '@/lib/time'

import { RunFact, RunSection } from '../components/run-sections'
import { useWorkflowRun } from '../hooks/use-workflow-run'
import { businessStatusPresentation, businessStatusToneClass } from '../view-model/display-status'

export function WorkflowRunView() {
  const { t } = useI18n()
  const copy = t.businessWorkspace.workflowDomain.run
  const { runId = '' } = useParams()
  const { actionFailed, actionId, cancel, failed, load, loading, overview, review } = useWorkflowRun(runId)

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-(--ui-chat-surface-background)">
        <Loader label={copy.loading} type="lemniscate-bloom" />
      </div>
    )
  }

  if (failed || !overview) {
    return (
      <div className="grid h-full place-items-center bg-(--ui-chat-surface-background) px-(--page-inset-x)">
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
  const canCancel = businessStatusPresentation('run', run.status).canCancel

  return (
    <section className="h-full overflow-y-auto bg-(--ui-chat-surface-background) px-(--page-inset-x) py-8">
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
            <span
              className={`text-xs font-medium ${businessStatusToneClass(businessStatusPresentation('run', run.status).tone)}`}
            >
              {copy.status(run.status)}
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

        <dl className="mt-6 grid gap-4 border-b border-(--ui-stroke-tertiary) pb-6 sm:grid-cols-3">
          <RunFact label={copy.executor} value={run.executorType} />
          <RunFact label={copy.attempt} value={`${run.attempt}/${run.maxAttempts}`} />
          <RunFact label={copy.created} value={fmtDayTime.format(new Date(run.createdAt))} />
        </dl>

        <RunSection title={copy.timeline}>
          {events.length ? (
            events.map(event => (
              <div
                className="flex items-start gap-3 border-b border-(--ui-stroke-tertiary) py-3 last:border-b-0"
                key={event.id}
              >
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{copy.event(event.eventType)}</p>
                  <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">
                    #{event.sequence} · {fmtDayTime.format(new Date(event.happenedAt))}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <EmptyState description={copy.noEvents} title={copy.waitingForEvents} />
          )}
        </RunSection>

        <RunSection title={copy.deliverables}>
          {deliverables.length ? (
            deliverables.map(deliverable => {
              const latestReview = deliverable.reviews.at(-1)
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
                            businessStatusPresentation('deliverable', latestReview?.status || deliverable.status).tone
                          )}`}
                        >
                          {copy.status(latestReview?.status || deliverable.status)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {copy.evidence(deliverable.evidenceManifest.length)} · {deliverable.kind}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button disabled={reviewBusy} onClick={() => void review(deliverable.id, 'approved')} size="sm">
                          <Codicon name="check" />
                          {copy.approve}
                        </Button>
                        <Button
                          disabled={reviewBusy}
                          onClick={() => void review(deliverable.id, 'changes_requested')}
                          size="sm"
                          variant="outline"
                        >
                          <Codicon name="edit" />
                          {copy.requestChanges}
                        </Button>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })
          ) : (
            <EmptyState description={copy.noDeliverablesDescription} title={copy.noDeliverablesTitle} />
          )}
        </RunSection>
      </div>
    </section>
  )
}
