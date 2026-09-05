export type BusinessDisplayObject = 'activity' | 'deliverable' | 'project' | 'run' | 'workflow'

export type BusinessStatusTone = 'accent' | 'attention' | 'danger' | 'muted' | 'success'

export interface BusinessStatusPresentation {
  active: boolean
  canCancel: boolean
  canonical: string
  poll: boolean
  terminal: boolean
  tone: BusinessStatusTone
}

const DEFAULT_STATUS: BusinessStatusPresentation = {
  active: false,
  canCancel: false,
  canonical: 'unknown',
  poll: false,
  terminal: false,
  tone: 'muted'
}

type StatusTable = Record<string, Partial<Omit<BusinessStatusPresentation, 'canonical'>>>

const PROJECT_STATUSES: StatusTable = {
  active: { active: true, tone: 'accent' },
  archived: { terminal: true, tone: 'muted' },
  completed: { terminal: true, tone: 'success' },
  failed: { terminal: true, tone: 'danger' },
  paused: { tone: 'muted' },
  waiting_review: { active: true, tone: 'attention' }
}

const WORKFLOW_STATUSES: StatusTable = {
  active: { active: true, tone: 'accent' },
  archived: { terminal: true, tone: 'muted' },
  draft: { tone: 'muted' },
  published: { active: true, tone: 'success' }
}

const RUN_STATUSES: StatusTable = {
  cancelled: { terminal: true, tone: 'danger' },
  failed: { terminal: true, tone: 'danger' },
  queued: { active: true, canCancel: true, poll: true, tone: 'accent' },
  running: { active: true, canCancel: true, poll: true, tone: 'accent' },
  succeeded: { terminal: true, tone: 'success' },
  timed_out: { terminal: true, tone: 'danger' },
  waiting_review: { active: true, tone: 'attention' }
}

const DELIVERABLE_STATUSES: StatusTable = {
  approved: { terminal: true, tone: 'success' },
  changes_requested: { active: true, tone: 'attention' },
  draft: { tone: 'muted' },
  ready: { active: true, tone: 'accent' },
  rejected: { terminal: true, tone: 'danger' }
}

const ACTIVITY_STATUSES: StatusTable = {
  approved: { terminal: true, tone: 'success' },
  cancelled: { terminal: true, tone: 'danger' },
  completed: { terminal: true, tone: 'success' },
  failed: { terminal: true, tone: 'danger' },
  queued: { active: true, tone: 'accent' },
  rejected: { terminal: true, tone: 'danger' },
  running: { active: true, tone: 'accent' },
  succeeded: { terminal: true, tone: 'success' },
  timed_out: { terminal: true, tone: 'danger' },
  waiting_review: { active: true, tone: 'attention' }
}

const STATUS_TABLES: Record<BusinessDisplayObject, StatusTable> = {
  activity: ACTIVITY_STATUSES,
  deliverable: DELIVERABLE_STATUSES,
  project: PROJECT_STATUSES,
  run: RUN_STATUSES,
  workflow: WORKFLOW_STATUSES
}

const STATUS_TONE_CLASSES: Record<BusinessStatusTone, string> = {
  accent: 'text-primary',
  attention: 'text-amber-600',
  danger: 'text-destructive',
  muted: 'text-(--ui-text-tertiary)',
  success: 'text-emerald-600'
}

/** One semantic mapping for every business object; localized labels stay in i18n. */
export function businessStatusPresentation(
  object: BusinessDisplayObject,
  rawStatus: null | string | undefined
): BusinessStatusPresentation {
  const canonical = rawStatus?.trim().toLowerCase() || DEFAULT_STATUS.canonical
  const mapped = STATUS_TABLES[object][canonical]

  return { ...DEFAULT_STATUS, ...mapped, canonical }
}

export function businessStatusToneClass(tone: BusinessStatusTone): string {
  return STATUS_TONE_CLASSES[tone]
}
