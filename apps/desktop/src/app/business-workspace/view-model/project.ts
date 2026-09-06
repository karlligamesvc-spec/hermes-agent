import type { WorkflowProject } from '../api/types'

/** Avoid repeating the same user-authored string as both title and body. */
export function distinctProjectObjective(project: Pick<WorkflowProject, 'name' | 'objective'>): null | string {
  const name = project.name.trim()
  const objective = project.objective.trim()

  return objective && objective !== name ? objective : null
}
