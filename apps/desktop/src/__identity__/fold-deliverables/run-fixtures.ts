/**
 * hc-1129 identity guard fixtures: runs with one of each thing the run drawer's
 * deliverable area shows. The goldens beside this file were recorded on fork main
 * b881175df2, before any hc-1129 code existed, so this file keeps to the types
 * main already had.
 */
import type { WorkflowRunOverview } from '@/app/business-workspace/api/types'

const deliverable = (id: string, title: string, status: string): WorkflowRunOverview['deliverables'][number] => ({
  createdAt: '2026-10-20T10:03:00Z',
  evidenceCount: 1,
  id,
  kind: 'report',
  openReference: null,
  reviews: [],
  status,
  title,
  updatedAt: '2026-10-20T10:03:00Z'
})

const run = (id: string, status: string): WorkflowRunOverview['run'] => ({
  attempt: 1,
  completedAt: null,
  createdAt: '2026-10-20T10:00:00Z',
  executorType: 'hermes',
  id,
  maxAttempts: 2,
  startedAt: '2026-10-20T10:00:02Z',
  status,
  triggerRef: '分析本周竞品',
  updatedAt: '2026-10-20T10:03:00Z'
})

const event = { eventType: 'run.queued', happenedAt: '2026-10-20T10:00:00Z', id: 'event-1', sequence: 1 }

/** One deliverable waiting on a decision and one already decided, so both kinds of row show. */
export const RUN_IN_REVIEW: WorkflowRunOverview = {
  deliverables: [
    deliverable('deliverable-pending', '本周报告', 'ready'),
    deliverable('deliverable-decided', '上周报告', 'approved')
  ],
  events: [event],
  run: run('run-review', 'waiting_review'),
  steps: []
}

export const RUN_SUCCEEDED: WorkflowRunOverview = {
  deliverables: [deliverable('deliverable-done', '上周报告', 'approved')],
  events: [event],
  run: { ...run('run-done', 'succeeded'), completedAt: '2026-10-20T10:05:00Z' },
  steps: []
}

export const RUN_RUNNING_EMPTY: WorkflowRunOverview = {
  deliverables: [],
  events: [event],
  run: run('run-empty', 'running'),
  steps: []
}
