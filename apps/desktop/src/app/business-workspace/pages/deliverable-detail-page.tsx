import { useState } from 'react'
import { useParams } from 'react-router'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'

import { openWorkflowUserFile, reviewWorkflowDeliverable } from '../api/adapters'
import type { WorkflowDeliverable } from '../api/types'
import { RunFact, RunSection } from '../components/run-sections'
import { useWorkflowDeliverable } from '../hooks/use-workflow-deliverables'

function deliverableSummary(item: WorkflowDeliverable): string {
  return item.payload.summary || item.payload.content || item.payload.filename || ''
}

export function DeliverableDetailView() {
  const { locale, t } = useI18n()
  const copy = t.businessWorkspace.workflowDomain.deliverables
  const { deliverableId } = useParams()
  const [reloadToken, setReloadToken] = useState(0)
  const [note, setNote] = useState('')
  const [noteRequired, setNoteRequired] = useState(false)
  const [error, setError] = useState<null | 'open' | 'review'>(null)
  const [action, setAction] = useState<null | 'approve' | 'changes' | 'open'>(null)
  const state = useWorkflowDeliverable(deliverableId, reloadToken)

  const submitReview = async (status: 'approved' | 'changes_requested') => {
    const normalizedNote = note.trim()

    if (status === 'changes_requested' && !normalizedNote) {
      setNoteRequired(true)

      return
    }

    if (!deliverableId) {
      return
    }

    setError(null)
    setNoteRequired(false)
    setAction(status === 'approved' ? 'approve' : 'changes')

    try {
      const ok = await reviewWorkflowDeliverable(deliverableId, status, normalizedNote || undefined)

      if (!ok) {
        setError('review')

        return
      }

      setNote('')
      setReloadToken(token => token + 1)
    } catch {
      setError('review')
    } finally {
      setAction(null)
    }
  }

  const openResult = async (fileId: string) => {
    setError(null)
    setAction('open')

    try {
      if (!(await openWorkflowUserFile(fileId))) {
        setError('open')
      }
    } catch {
      setError('open')
    } finally {
      setAction(null)
    }
  }

  if (state.mode === 'loading') {
    return (
      <div className="grid h-full place-items-center bg-(--ui-chat-surface-background)">
        <Loader label={copy.loading} type="lemniscate-bloom" />
      </div>
    )
  }

  if (state.mode !== 'ready') {
    return (
      <div className={`grid h-full place-items-center bg-(--ui-chat-surface-background) ${PAGE_INSET_X}`}>
        <ErrorState
          description={state.mode === 'unavailable' ? copy.unavailableDescription : copy.loadFailedDescription}
          title={state.mode === 'unavailable' ? copy.unavailableTitle : copy.loadFailedTitle}
        >
          <Button onClick={() => setReloadToken(token => token + 1)} size="sm" variant="outline">
            <Codicon name="refresh" />
            {copy.refresh}
          </Button>
        </ErrorState>
      </div>
    )
  }

  const { item, project, run, workflow } = state.detail
  const summary = deliverableSummary(item)
  const canReview = !['approved', 'rejected', 'superseded'].includes(item.status)

  return (
    <section
      className="h-full overflow-y-auto bg-(--ui-chat-surface-background) px-(--route-drawer-content-inset,var(--page-inset-x)) py-8"
      data-deliverable-detail=""
      data-route-drawer-scroll=""
    >
      <div className="mx-auto w-full max-w-4xl pb-10">
        <header className="border-b border-(--ui-stroke-tertiary) pb-5 pr-(--route-drawer-action-clearance,0rem)">
          <p className="text-xs font-medium text-primary">{copy.detailEyebrow}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{item.title}</h1>
            <Badge
              variant={item.status === 'approved' ? 'default' : item.status === 'changes_requested' ? 'warn' : 'muted'}
            >
              {copy.status(item.status)}
            </Badge>
            <Badge variant="outline">{copy.kind(item.kind)}</Badge>
          </div>
          {summary && (
            <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{summary}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={!item.storageTarget || action !== null}
              onClick={() => item.storageTarget && void openResult(item.storageTarget.id)}
              size="sm"
              variant="outline"
            >
              <Codicon name="link-external" />
              {item.storageTarget ? copy.open : copy.openUnavailable}
            </Button>
          </div>
          {error === 'open' && (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {copy.openFailed}
            </p>
          )}
        </header>

        <dl className="grid gap-4 border-b border-(--ui-stroke-tertiary) py-6 sm:grid-cols-2">
          <RunFact label={copy.project} value={project.name} />
          <RunFact label={copy.workflow} value={workflow.name} />
          <RunFact label={copy.run} value={run.id} />
          <RunFact label={copy.created} value={formatBusinessDayTime(new Date(item.createdAt), locale)} />
          <RunFact label={copy.updated} value={formatBusinessDayTime(new Date(item.updatedAt), locale)} />
          {item.sourceCapturedAt && (
            <RunFact
              label={copy.sourceCaptured}
              value={formatBusinessDayTime(new Date(item.sourceCapturedAt), locale)}
            />
          )}
        </dl>

        {item.payload.content && item.payload.content !== summary && (
          <RunSection title={copy.content}>
            <p className="whitespace-pre-wrap py-4 text-sm leading-6 text-(--ui-text-secondary)">
              {item.payload.content}
            </p>
          </RunSection>
        )}

        {item.payload.highlights?.length ? (
          <RunSection title={copy.highlights}>
            <ul className="space-y-2 py-4">
              {item.payload.highlights.map((highlight, index) => (
                <li className="flex gap-3 text-sm leading-6 text-(--ui-text-secondary)" key={`${highlight}:${index}`}>
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          </RunSection>
        ) : null}

        <RunSection title={copy.evidence}>
          {item.evidence.length ? (
            <div className="py-2">
              {item.evidence.map((evidence, index) => (
                <article
                  className="border-b border-(--ui-stroke-tertiary) py-3 last:border-b-0"
                  key={`${evidence.url || evidence.source || 'evidence'}:${index}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{evidence.title || evidence.source || copy.evidence}</p>
                    {evidence.verified !== undefined && (
                      <Badge variant="outline">{evidence.verified ? copy.verified : copy.notVerified}</Badge>
                    )}
                  </div>
                  {evidence.quote && (
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-(--ui-text-secondary)">
                      {evidence.quote}
                    </p>
                  )}
                  {evidence.url && <p className="mt-1 break-all text-xs text-(--ui-text-tertiary)">{evidence.url}</p>}
                </article>
              ))}
            </div>
          ) : (
            <EmptyState description={copy.noEvidence} title={copy.evidence} />
          )}
        </RunSection>

        {item.verifierResult && (
          <RunSection title={copy.verifier}>
            <dl className="grid gap-4 py-4 sm:grid-cols-2">
              {item.verifierResult.passed !== undefined && (
                <RunFact
                  label={copy.verificationOutcome}
                  value={item.verifierResult.passed ? copy.verified : copy.notVerified}
                />
              )}
              {item.verifierResult.reason && (
                <RunFact label={copy.verificationReason} value={item.verifierResult.reason} />
              )}
              {item.verifierResult.evidenceCount !== undefined && (
                <RunFact label={copy.evidence} value={copy.evidenceCount(item.verifierResult.evidenceCount)} />
              )}
              {item.verifierResult.citationCoverage !== undefined && (
                <RunFact
                  label={copy.citationCoverage}
                  value={`${Math.round(item.verifierResult.citationCoverage * 100)}%`}
                />
              )}
              {item.verifierResult.checkedAt && (
                <RunFact
                  label={copy.verificationChecked}
                  value={formatBusinessDayTime(new Date(item.verifierResult.checkedAt), locale)}
                />
              )}
            </dl>
          </RunSection>
        )}

        {canReview && (
          <RunSection title={copy.reviewNote}>
            <div className="space-y-3 py-4">
              {error === 'review' && (
                <p className="text-xs text-destructive" role="alert">
                  {copy.actionFailed}
                </p>
              )}
              <Textarea
                aria-invalid={noteRequired}
                aria-label={copy.reviewNote}
                disabled={action !== null}
                maxLength={8000}
                onChange={event => {
                  setNote(event.target.value)

                  if (event.target.value.trim()) {
                    setNoteRequired(false)
                  }
                }}
                placeholder={copy.reviewNotePlaceholder}
                value={note}
              />
              {noteRequired && <p className="text-xs text-destructive">{copy.reviewNoteRequired}</p>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={action !== null} onClick={() => void submitReview('approved')} size="sm">
                  <Codicon name="check" />
                  {action === 'approve' ? copy.submitting : copy.approve}
                </Button>
                <Button
                  disabled={action !== null}
                  onClick={() => void submitReview('changes_requested')}
                  size="sm"
                  variant="outline"
                >
                  <Codicon name="edit" />
                  {action === 'changes' ? copy.submitting : copy.requestChanges}
                </Button>
              </div>
            </div>
          </RunSection>
        )}

        <RunSection title={copy.reviews}>
          {item.reviews.length ? (
            item.reviews.map(review => (
              <article className="border-b border-(--ui-stroke-tertiary) py-3 last:border-b-0" key={review.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{copy.reviewRound(review.roundNumber)}</p>
                  <Badge
                    variant={
                      review.status === 'approved'
                        ? 'default'
                        : review.status === 'changes_requested'
                          ? 'warn'
                          : 'muted'
                    }
                  >
                    {copy.status(review.status)}
                  </Badge>
                </div>
                {review.notes && (
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-(--ui-text-secondary)">
                    {review.notes}
                  </p>
                )}
                {review.updatedAt && (
                  <p className="mt-1 text-xs text-(--ui-text-tertiary)">
                    {formatBusinessDayTime(new Date(review.updatedAt), locale)}
                  </p>
                )}
              </article>
            ))
          ) : (
            <EmptyState description={copy.noReviews} title={copy.reviews} />
          )}
        </RunSection>
      </div>
    </section>
  )
}
