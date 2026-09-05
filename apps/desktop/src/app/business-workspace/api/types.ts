export interface WorkflowDomainBridge {
  access: () => Promise<{ available: boolean }>
  cancelRun: (runId: string) => Promise<{ ok: boolean }>
  getCatalog?: () => Promise<WorkflowCatalogResult>
  getRun: (runId: string) => Promise<{ ok: boolean; overview?: WorkflowRunOverview }>
  listProjects?: (options?: {
    cursor?: string
    limit?: number
    status?: string
  }) => Promise<WorkflowProjectListResult>
  listWorkflows?: (options?: {
    cursor?: string
    limit?: number
    projectId?: string
    status?: string
  }) => Promise<WorkflowListResult>
  reviewDeliverable: (payload: {
    deliverableId: string
    status: 'approved' | 'changes_requested'
  }) => Promise<{ ok: boolean }>
  startGoal: (payload: {
    objective: string
    starter: { description: string; id: string; name: string; slug: string; version: number }
  }) => Promise<{ ok: boolean; run?: { id: string } }>
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

export interface WorkflowRunOverview {
  deliverables: Array<{
    createdAt: string
    evidenceManifest: Array<Record<string, unknown>>
    id: string
    kind: string
    reviews: Array<{ id: string; status: 'approved' | 'changes_requested' | 'rejected' }>
    status: string
    title: string
  }>
  events: Array<{
    eventType: string
    happenedAt: string
    id: string
    payload: Record<string, unknown>
    sequence: number
  }>
  run: {
    attempt: number
    createdAt: string
    errorMessage: null | string
    executorType: string
    id: string
    maxAttempts: number
    status: string
    triggerRef: null | string
  }
}

export type StartWorkflowGoalOutcome =
  | { mode: 'failed' }
  | { mode: 'started'; runId: string }
  | { mode: 'unavailable' }
