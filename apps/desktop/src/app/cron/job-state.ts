import type { CronJob } from '@/types/hermes'

// Status-pip color per cron job state. Single source for the sidebar section and
// the Cron page so the two never drift. (Animation/size live at the call site.)
export const STATE_DOT: Record<string, string> = {
  completed: 'bg-(--ui-text-quaternary)',
  disabled: 'bg-(--ui-text-quaternary)',
  enabled: 'bg-primary',
  error: 'bg-destructive',
  paused: 'bg-amber-500',
  running: 'bg-primary',
  scheduled: 'bg-primary'
}

// Effective state: explicit state wins; otherwise infer from the enabled flag.
export function jobState(job: CronJob): string {
  const state = typeof job.state === 'string' ? job.state.trim() : ''

  return state || (job.enabled === false ? 'disabled' : 'scheduled')
}

export type CronJobOutcome =
  'succeeded' | 'failed' | 'blocked' | 'interrupted' | 'delivery-failed' | 'delivery-pending' | 'unknown'

const OUTCOMES: Record<string, CronJobOutcome> = {
  ok: 'succeeded',
  error: 'failed',
  blocked_config: 'blocked',
  interrupted: 'interrupted',
  delivery_failed: 'delivery-failed',
  delivery_queued: 'delivery-pending'
}

/** Scheduling completion means no future dispatch; only last_status proves its result. */
export function jobOutcome(job: CronJob): CronJobOutcome | null {
  const status = typeof job.last_status === 'string' ? job.last_status.trim() : ''

  if (status) {
    return OUTCOMES[status] ?? 'unknown'
  }

  const state = jobState(job)

  return state === 'error' ? 'failed' : state === 'completed' ? 'unknown' : null
}

export function jobOutcomeFailed(outcome: CronJobOutcome | null): boolean {
  return outcome === 'failed' || outcome === 'blocked' || outcome === 'interrupted' || outcome === 'delivery-failed'
}

/** Keep delivery diagnostics separate from execution diagnostics. */
export function jobOutcomeError(job: CronJob): null | string {
  const outcome = jobOutcome(job)

  const error =
    outcome === 'delivery-failed' ? job.last_delivery_error : jobOutcomeFailed(outcome) ? job.last_error : null

  return typeof error === 'string' && error.trim() ? error.trim() : null
}

/** A running retry retains its active pip; settled failures remain visible in every list. */
export function jobDotClass(job: CronJob): string {
  const state = jobState(job)

  return state !== 'running' && jobOutcomeFailed(jobOutcome(job))
    ? STATE_DOT.error
    : (STATE_DOT[state] ?? STATE_DOT.completed)
}

// Human label for a job: name → first 60 of prompt → first 60 of script → id.
// One source for the sidebar row and the Cron page so the two never drift.
export function jobTitle(job: CronJob): string {
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const clip = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)

  return pick(job.name) || clip(pick(job.prompt)) || clip(pick(job.script)) || job.id || 'Cron job'
}
