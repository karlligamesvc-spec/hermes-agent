import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import { workflowDomainBridge } from './bridge'
import type { StartWorkflowGoalOutcome, WorkflowDomainBridge, WorkflowRunOverview } from './types'

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
