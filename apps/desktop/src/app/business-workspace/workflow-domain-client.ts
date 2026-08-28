import type { BusinessWorkflowStarter } from './workflow-starters'

type WorkflowDomainBridge = {
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

export type WorkflowRunOverview = {
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

export type StartWorkflowGoalOutcome = { mode: 'failed' } | { mode: 'started'; runId: string } | { mode: 'unavailable' }

export function workflowDomainBridge(): null | WorkflowDomainBridge {
  return (window.hermesDesktop?.workflowDomain as WorkflowDomainBridge | undefined) ?? null
}

export async function startWorkflowGoal(
  objective: string,
  starter: BusinessWorkflowStarter,
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<StartWorkflowGoalOutcome> {
  if (!bridge) {
    return { mode: 'unavailable' }
  }

  let access

  try {
    access = await bridge.access()
  } catch {
    return { mode: 'unavailable' }
  }

  if (!access.available) {
    return { mode: 'unavailable' }
  }

  try {
    const result = await bridge.startGoal({
      objective,
      starter: { description: starter.summary, name: starter.title, slug: starter.slug }
    })

    const runId = result.run?.id?.trim()

    return result.ok && runId ? { mode: 'started', runId } : { mode: 'failed' }
  } catch {
    return { mode: 'failed' }
  }
}

export async function getWorkflowRun(runId: string): Promise<null | WorkflowRunOverview> {
  const bridge = workflowDomainBridge()

  if (!bridge) {return null}

  const result = await bridge.getRun(runId)

  return result.ok && result.overview ? result.overview : null
}

export async function cancelWorkflowRun(runId: string): Promise<boolean> {
  const bridge = workflowDomainBridge()

  return bridge ? (await bridge.cancelRun(runId)).ok : false
}

export async function reviewWorkflowDeliverable(
  deliverableId: string,
  status: 'approved' | 'changes_requested'
): Promise<boolean> {
  const bridge = workflowDomainBridge()

  return bridge ? (await bridge.reviewDeliverable({ deliverableId, status })).ok : false
}
