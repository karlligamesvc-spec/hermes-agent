import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import { workflowDomainBridge } from './bridge'
import type {
  StartWorkflowGoalOutcome,
  WorkflowCatalogItem,
  WorkflowDefinition,
  WorkflowDomainBridge,
  WorkflowProject,
  WorkflowRunOverview
} from './types'

export type WorkflowProjectListOutcome =
  | { items: WorkflowProject[]; mode: 'ready'; nextCursor: null | string; total: number }
  | { mode: 'failed' }
  | { mode: 'unavailable' }

export type WorkflowListOutcome =
  | { catalog: WorkflowCatalogItem[]; items: WorkflowDefinition[]; mode: 'ready' }
  | { mode: 'failed' }
  | { mode: 'unavailable' }

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
      starter: {
        description: starter.summary,
        id: starter.id,
        name: starter.title,
        slug: starter.slug,
        version: starter.version
      }
    })

    const runId = result.run?.id?.trim()

    return result.ok && runId ? { mode: 'started', runId } : { mode: 'failed' }
  } catch {
    return { mode: 'failed' }
  }
}

export async function listWorkflowProjects(
  options: { limit?: number; status?: string } = {},
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<WorkflowProjectListOutcome> {
  if (!bridge?.listProjects) {
    return { mode: 'unavailable' }
  }

  try {
    const access = await bridge.access()

    if (!access.available) {
      return { mode: 'unavailable' }
    }

    const result = await bridge.listProjects(options)

    return result.ok && Array.isArray(result.items)
      ? {
          items: result.items,
          mode: 'ready',
          nextCursor: result.nextCursor ?? null,
          total: result.total ?? result.items.length
        }
      : { mode: 'failed' }
  } catch {
    return { mode: 'failed' }
  }
}

export async function listWorkflowDefinitions(
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<WorkflowListOutcome> {
  if (!bridge?.getCatalog || !bridge.listWorkflows) {
    return { mode: 'unavailable' }
  }

  try {
    const access = await bridge.access()

    if (!access.available) {
      return { mode: 'unavailable' }
    }

    const [catalog, workflows] = await Promise.all([bridge.getCatalog(), bridge.listWorkflows({ limit: 50 })])

    return catalog.ok && workflows.ok && Array.isArray(catalog.items) && Array.isArray(workflows.items)
      ? { catalog: catalog.items, items: workflows.items, mode: 'ready' }
      : { mode: 'failed' }
  } catch {
    return { mode: 'failed' }
  }
}

export async function getWorkflowRun(runId: string): Promise<null | WorkflowRunOverview> {
  const bridge = workflowDomainBridge()

  if (!bridge) {
    return null
  }

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
