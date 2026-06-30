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

// Ring (outline) color matching STATE_DOT, for the Claude "已安排" hollow status
// circle — the empty ring shown for a job that isn't actively live. Kept as
// full literal classes (not derived) so Tailwind's static scanner emits them.
export const STATE_RING: Record<string, string> = {
  completed: 'ring-(--ui-text-quaternary)',
  disabled: 'ring-(--ui-text-quaternary)',
  enabled: 'ring-primary',
  error: 'ring-destructive',
  paused: 'ring-amber-500',
  running: 'ring-primary',
  scheduled: 'ring-primary'
}

// Effective state: explicit state wins; otherwise infer from the enabled flag.
export function jobState(job: CronJob): string {
  const state = typeof job.state === 'string' ? job.state.trim() : ''

  return state || (job.enabled === false ? 'disabled' : 'scheduled')
}

// Human label for a job: name → first 60 of prompt → first 60 of script → id.
// One source for the sidebar row and the Cron page so the two never drift.
export function jobTitle(job: CronJob): string {
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const clip = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)

  return pick(job.name) || clip(pick(job.prompt)) || clip(pick(job.script)) || job.id || 'Cron job'
}
