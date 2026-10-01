import type { WorkflowProject, WorkflowProjectCompletion } from '../api/types'

export type ProjectFilter = 'all' | 'not-started' | 'in-progress' | 'awaiting-acceptance' | 'completed'
export const PROJECT_FILTERS: ProjectFilter[] = ['all', 'not-started', 'in-progress', 'awaiting-acceptance', 'completed']

/** Presentation only: manual Project lifecycle remains authoritative. */
export function projectPresentationStage(project: WorkflowProject, facts: WorkflowProjectCompletion | null): Exclude<ProjectFilter, 'all'> | null {
  if (project.status === 'completed') {return 'completed'}

  if (project.status !== 'active' || !facts || facts.projectStatus !== project.status) {return null}

  if (facts.readyForReview && facts.workflowTotal > 0 && facts.workflowSucceeded === facts.workflowTotal) {
    return 'awaiting-acceptance'
  }

  if (facts.workflowTotal === 0 || (facts.workflowStates.length === facts.workflowTotal && facts.workflowStates.every(state => state.runId === null))) {
    return 'not-started'
  }

  return 'in-progress'
}
