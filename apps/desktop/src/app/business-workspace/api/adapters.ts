import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import { workflowDomainBridge } from './bridge'
import type {
  CreateWorkflowProjectOutcome,
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

export type WorkflowProjectOutcome =
  | { item: WorkflowProject; mode: 'ready' }
  | { mode: 'failed' }
  | { mode: 'unavailable' }

export type WorkflowCatalogOutcome =
  | { items: WorkflowCatalogItem[]; mode: 'ready'; version: null | string }
  | { mode: 'failed' }
  | { mode: 'unavailable' }

export type WorkflowDefinitionListOutcome =
  | { items: WorkflowDefinition[]; mode: 'ready' }
  | { mode: 'failed' }
  | { mode: 'unavailable' }

export async function startWorkflowGoal(
  objective: string,
  starter: BusinessWorkflowStarter,
  projectIdOrBridge?: null | string | WorkflowDomainBridge,
  fallbackBridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<StartWorkflowGoalOutcome> {
  const projectId = typeof projectIdOrBridge === 'string' ? projectIdOrBridge : undefined
  const bridge = typeof projectIdOrBridge === 'string' || projectIdOrBridge === undefined ? fallbackBridge : projectIdOrBridge

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
      ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
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

export async function createWorkflowProject(
  input: { localPath?: string; name: string; objective: string },
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<CreateWorkflowProjectOutcome> {
  if (!bridge?.createProject) {
    return { mode: 'unavailable' }
  }

  try {
    const access = await bridge.access()

    if (!access.available) {
      return { mode: 'unavailable' }
    }

    const result = await bridge.createProject(input)

    return result.ok && result.item ? { item: result.item, mode: 'created' } : { mode: 'failed' }
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

export async function getWorkflowProject(
  projectId: string,
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<WorkflowProjectOutcome> {
  const normalizedProjectId = projectId.trim()

  if (!bridge?.getProject || !normalizedProjectId) {
    return { mode: 'unavailable' }
  }

  try {
    const access = await bridge.access()

    if (!access.available) {
      return { mode: 'unavailable' }
    }

    const result = await bridge.getProject(normalizedProjectId)

    return result.ok && result.item ? { item: result.item, mode: 'ready' } : { mode: 'failed' }
  } catch {
    return { mode: 'failed' }
  }
}

export async function listWorkflowCatalog(
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<WorkflowCatalogOutcome> {
  if (!bridge?.getCatalog) {
    return { mode: 'unavailable' }
  }

  try {
    const access = await bridge.access()

    if (!access.available) {
      return { mode: 'unavailable' }
    }

    const catalog = await bridge.getCatalog()

    return catalog.ok && Array.isArray(catalog.items)
      ? { items: catalog.items, mode: 'ready', version: catalog.version ?? null }
      : { mode: 'failed' }
  } catch {
    return { mode: 'failed' }
  }
}

export async function listWorkflowDefinitions(
  options: { limit?: number; projectId?: string; status?: string } = {},
  bridge: null | WorkflowDomainBridge = workflowDomainBridge()
): Promise<WorkflowDefinitionListOutcome> {
  if (!bridge?.listWorkflows) {
    return { mode: 'unavailable' }
  }

  try {
    const access = await bridge.access()

    if (!access.available) {
      return { mode: 'unavailable' }
    }

    const workflows = await bridge.listWorkflows(options)

    return workflows.ok && Array.isArray(workflows.items)
      ? { items: workflows.items, mode: 'ready' }
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
