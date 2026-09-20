export interface WorkflowDomainBridge {
  access: () => Promise<{ available: boolean }>
  cancelRun: (runId: string) => Promise<{ ok: boolean }>
  createProject?: (payload: {
    localPath?: string
    name: string
    objective: string
  }) => Promise<{ item?: WorkflowProject; ok: boolean }>
  getProject?: (projectId: string) => Promise<{ item?: WorkflowProject; ok: boolean }>
  getCatalog?: () => Promise<WorkflowCatalogResult>
  getVideoCatalog?: () => Promise<WorkflowVideoCatalogResult>
  getDeliverable?: (deliverableId: string) => Promise<WorkflowDeliverableDetailResult>
  getRun: (runId: string) => Promise<{ ok: boolean; overview?: WorkflowRunOverview }>
  listActivity?: (options?: { cursor?: string; kinds?: string; limit?: number }) => Promise<WorkflowActivityListResult>
  listDeliverables?: (options?: {
    cursor?: string
    kind?: string
    limit?: number
    projectId?: string
    status?: string
  }) => Promise<WorkflowDeliverableListResult>
  listProjects?: (options?: { cursor?: string; limit?: number; status?: string }) => Promise<WorkflowProjectListResult>
  listWorkflows?: (options?: {
    cursor?: string
    limit?: number
    projectId?: string
    status?: string
  }) => Promise<WorkflowListResult>
  reviewDeliverable: (payload: {
    deliverableId: string
    notes?: string
    status: 'approved' | 'changes_requested'
  }) => Promise<{ ok: boolean }>
  retryRunStep?: (payload: { runId: string; stepKey: string }) => Promise<{ ok: boolean }>
  openUserFile?: (fileId: string) => Promise<{ ok: boolean }>
  startGoal: (payload: {
    objective: string
    projectId?: string
    starter: { description: string; id: string; name: string; slug: string; version: number }
  }) => Promise<{ ok: boolean; run?: { id: string } }>
}

export interface WorkflowReview {
  createdAt: null | string
  decidedAt: null | string
  id: string
  metrics: Record<string, boolean | number>
  nextAction: null | { label?: string; targetId?: string; type?: string }
  notes: null | string
  reviewerType: string
  roundNumber: number
  status: 'approved' | 'changes_requested' | 'pending' | 'rejected'
  updatedAt: null | string
}

export interface WorkflowEvidence {
  capturedAt?: string
  quote?: string
  source?: string
  title?: string
  url?: string
  verificationStatus?: string
  verified?: boolean
}

export interface WorkflowDeliverable {
  createdAt: string
  evidence: WorkflowEvidence[]
  executorType: 'hermes'
  executorVersion: null | string
  id: string
  kind: string
  payload: {
    content?: string
    filename?: string
    format?: string
    highlights?: string[]
    mimeType?: string
    partial?: boolean
    summary?: string
  }
  projectId: string
  reviews: WorkflowReview[]
  runId: string
  schemaVersion: string
  sourceCapturedAt: null | string
  status: string
  storageTarget: null | { id: string; kind: 'user_file' }
  title: string
  updatedAt: string
  verifierResult: null | {
    checkedAt?: string
    citationCoverage?: number
    evidenceCount?: number
    passed?: boolean
    reason?: string
    status?: string
  }
}

export interface WorkflowDeliverableListResult {
  items?: WorkflowDeliverable[]
  nextCursor?: null | string
  ok: boolean
}

export interface WorkflowDeliverableDetail {
  item: WorkflowDeliverable
  project: WorkflowProject
  run: {
    completedAt: null | string
    createdAt: string
    id: string
    startedAt: null | string
    status: string
    updatedAt: string
  }
  workflow: WorkflowDefinition
}

export interface WorkflowDeliverableDetailResult {
  detail?: WorkflowDeliverableDetail
  ok: boolean
}

export interface WorkflowActivityItem {
  happenedAt: string
  id: string
  kind: 'deliverable' | 'review' | 'run'
  status: string
  summary: null | string
  target: { id: string; kind: 'deliverable' | 'run' }
  title: string
}

export interface WorkflowActivityListResult {
  items?: WorkflowActivityItem[]
  nextCursor?: null | string
  ok: boolean
}

export interface WorkflowProjectSummary {
  attention: 'failed' | 'none' | 'review'
  currentRunId: null | string
  currentRunStatus: null | string
  currentStepTitle: null | string
  deliverableCount: number
  stepCompleted: number
  stepTotal: number
}

export interface WorkflowProject {
  createdAt: string
  id: string
  name: string
  objective: string
  status: string
  // Phase 1 servers add the aggregate summary. Phase 0 servers return the
  // canonical Project fields without it, so the renderer must keep showing
  // those real projects without inventing run/progress data.
  summary?: WorkflowProjectSummary
  updatedAt: string
}

export interface WorkflowProjectListResult {
  items?: WorkflowProject[]
  nextCursor?: null | string
  ok: boolean
  total?: number
}

export interface WorkflowDefinition {
  createdAt: string
  description: null | string
  id: string
  name: string
  projectId: string
  slug: string
  status: string
  updatedAt: string
  version: null | number
}

export interface WorkflowListResult {
  items?: WorkflowDefinition[]
  nextCursor?: null | string
  ok: boolean
}

export interface WorkflowCatalogItem {
  businessPath: string
  id: string
  position: number
  recommended: boolean
  slug: string
  version: number
}

export interface WorkflowCatalogResult {
  items?: WorkflowCatalogItem[]
  ok: boolean
  version?: string
}

export interface WorkflowVideoCatalogItem {
  id: string
  kind: 'pipeline' | 'stage'
  name: string
  position: number
  recommended: boolean
  slug: string
  stepCount: number
  summary: string
  version: number
}

export interface WorkflowVideoCatalogResult {
  items?: WorkflowVideoCatalogItem[]
  ok: boolean
  version?: string
}

export interface WorkflowRunOverview {
  deliverables: Array<{
    createdAt: string
    evidenceCount: number
    id: string
    kind: string
    openReference: null | string
    reviews: Array<{
      createdAt: null | string
      id: string
      roundNumber: number
      status: 'approved' | 'changes_requested' | 'pending' | 'rejected'
    }>
    status: string
    title: string
    updatedAt: string
  }>
  events: Array<{
    eventType: string
    happenedAt: string
    id: string
    sequence: number
  }>
  run: {
    attempt: number
    completedAt: null | string
    createdAt: string
    executorType: string
    id: string
    maxAttempts: number
    startedAt: null | string
    status: string
    triggerRef: null | string
    updatedAt: string
  }
  steps: Array<{
    attempt: number
    completedAt: null | string
    createdAt: string
    evidenceCount: number
    id: string
    key: string
    position: number
    runId: string
    startedAt: null | string
    status: 'cancelled' | 'failed' | 'pending' | 'running' | 'skipped' | 'succeeded'
    summary: null | string
    title: string
    updatedAt: string
  }>
}

export type StartWorkflowGoalOutcome = { mode: 'failed' } | { mode: 'started'; runId: string } | { mode: 'unavailable' }

export type CreateWorkflowProjectOutcome =
  { item: WorkflowProject; mode: 'created' } | { mode: 'failed' } | { mode: 'unavailable' }
