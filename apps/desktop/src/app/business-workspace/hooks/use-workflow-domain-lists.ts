import { useEffect, useState } from 'react'

import {
  getWorkflowProject,
  listWorkflowDefinitions,
  listWorkflowProjects,
  type WorkflowListOutcome,
  type WorkflowProjectListOutcome,
  type WorkflowProjectOutcome
} from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'

type ProjectListState = WorkflowProjectListOutcome | { mode: 'loading' }
type ProjectState = WorkflowProjectOutcome | { mode: 'loading' }
type WorkflowListState = WorkflowListOutcome | { mode: 'loading' }

export function useWorkflowProjects(limit = 50): ProjectListState {
  const [state, setState] = useState<ProjectListState>(() =>
    workflowDomainBridge()?.listProjects ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    void listWorkflowProjects({ limit }).then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [limit])

  return state
}

export function useWorkflowProject(projectId: string | undefined): ProjectState {
  const [state, setState] = useState<ProjectState>(() =>
    projectId && workflowDomainBridge()?.getProject ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    if (!projectId) {
      setState({ mode: 'unavailable' })

      return () => {
        active = false
      }
    }

    setState({ mode: 'loading' })
    void getWorkflowProject(projectId).then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [projectId])

  return state
}

export function useWorkflowDefinitions(reloadToken = 0): WorkflowListState {
  const [state, setState] = useState<WorkflowListState>(() =>
    workflowDomainBridge()?.getCatalog && workflowDomainBridge()?.listWorkflows
      ? { mode: 'loading' }
      : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    setState({ mode: 'loading' })
    void listWorkflowDefinitions().then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [reloadToken])

  return state
}
