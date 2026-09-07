import type { WorkflowProject, WorkflowProjectSummary } from '../api/types'

/** Avoid repeating the same user-authored string as both title and body. */
export function distinctProjectObjective(project: Pick<WorkflowProject, 'name' | 'objective'>): null | string {
  const name = project.name.trim()
  const objective = project.objective.trim()

  return objective && objective !== name ? objective : null
}

/**
 * Phase 0 Project responses do not carry a summary. Normalize that older,
 * still-valid contract before the React compiler captures callback inputs so
 * a missing summary can never become an eager `summary.currentRunId` read.
 */
export function projectCurrentRunId(summary: undefined | WorkflowProjectSummary): null | string {
  const runId = summary?.currentRunId

  return typeof runId === 'string' && runId.trim() ? runId : null
}
