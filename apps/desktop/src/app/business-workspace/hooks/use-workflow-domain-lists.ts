import { useEffect, useState } from 'react'

import {
  listWorkflowDefinitions,
  listWorkflowProjects,
  type WorkflowListOutcome,
  type WorkflowProjectListOutcome
} from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'

type ProjectListState = WorkflowProjectListOutcome | { mode: 'loading' }
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

export function useWorkflowDefinitions(): WorkflowListState {
  const [state, setState] = useState<WorkflowListState>(() =>
    workflowDomainBridge()?.getCatalog && workflowDomainBridge()?.listWorkflows
      ? { mode: 'loading' }
      : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    void listWorkflowDefinitions().then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [])

  return state
}
