export interface WorkflowDomainBridge {
  access: () => Promise<{ available: boolean }>
  cancelRun: (runId: string) => Promise<{ ok: boolean }>
  getRun: (runId: string) => Promise<{ ok: boolean; overview?: WorkflowRunOverview }>
  reviewDeliverable: (payload: {
    deliverableId: string
    status: 'approved' | 'changes_requested'
  }) => Promise<{ ok: boolean }>
  startGoal: (payload: {
    objective: string
    starter: { description: string; name: string; slug: string }
  }) => Promise<{ ok: boolean; run?: { id: string } }>
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
