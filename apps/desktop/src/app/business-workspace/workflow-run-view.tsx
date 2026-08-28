import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { fmtDayTime } from '@/lib/time'

import {
  cancelWorkflowRun,
  getWorkflowRun,
  reviewWorkflowDeliverable,
  type WorkflowRunOverview
} from './workflow-domain-client'

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

function runStatusTone(status: string): string {
  if (['approved', 'completed', 'succeeded'].includes(status)) {return 'text-emerald-600'}

  if (['cancelled', 'failed', 'rejected', 'timed_out'].includes(status)) {return 'text-destructive'}

  if (ACTIVE_RUN_STATUSES.has(status)) {return 'text-primary'}

  return 'text-(--ui-text-tertiary)'
}

export function WorkflowRunView() {
  const { t } = useI18n()
  const copy = t.businessWorkspace.workflowDomain.run
  const { runId = '' } = useParams()
  const [overview, setOverview] = useState<null | WorkflowRunOverview>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [actionId, setActionId] = useState<null | string>(null)
  const [actionFailed, setActionFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)

    try {
      const next = runId ? await getWorkflowRun(runId) : null

      if (!next) {
        setFailed(true)

        return
      }

      setOverview(next)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!overview || !ACTIVE_RUN_STATUSES.has(overview.run.status)) {return}

    const timer = window.setInterval(() => void load(), 3000)

    return () => window.clearInterval(timer)
  }, [load, overview])

  const cancel = async () => {
    setActionFailed(false)
    setActionId('cancel')

    try {
      if (!(await cancelWorkflowRun(runId))) {
        setActionFailed(true)

        return
      }

      await load()
    } catch {
      setActionFailed(true)
    } finally {
      setActionId(null)
    }
  }

  const review = async (deliverableId: string, status: 'approved' | 'changes_requested') => {
    setActionFailed(false)
    setActionId(`${deliverableId}:${status}`)

    try {
      if (!(await reviewWorkflowDeliverable(deliverableId, status))) {
        setActionFailed(true)

        return
      }

      await load()
    } catch {
      setActionFailed(true)
    } finally {
      setActionId(null)
    }
  }

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
  const canCancel = ACTIVE_RUN_STATUSES.has(run.status)

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
            <span className={`text-xs font-medium ${runStatusTone(run.status)}`}>{copy.status(run.status)}</span>
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
                        <span className={`text-xs ${runStatusTone(latestReview?.status || deliverable.status)}`}>
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

function RunFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-(--ui-text-tertiary)">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium">{value}</dd>
    </div>
  )
}

function RunSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mt-8">
      <h2 className="border-b border-(--ui-stroke-tertiary) pb-2 text-sm font-semibold">{title}</h2>
      <div>{children}</div>
    </section>
  )
}
