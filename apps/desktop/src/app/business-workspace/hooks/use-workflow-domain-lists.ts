import { useCallback, useEffect, useState } from 'react'

import {
  getWorkflowProject,
  getWorkflowProjectCompletion,
  listVideoWorkflowCatalog,
  listWorkflowCatalog,
  listWorkflowDefinitions,
  listWorkflowProjects,
  type WorkflowCatalogOutcome,
  type WorkflowProjectCompletionOutcome,
  type WorkflowProjectOutcome,
  type WorkflowVideoCatalogOutcome
} from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'

import { useWorkflowDomainRead } from './use-workflow-domain-read'

type WorkflowCatalogState = WorkflowCatalogOutcome | { mode: 'loading' }
type WorkflowVideoCatalogState = WorkflowVideoCatalogOutcome | { mode: 'loading' }

export function useWorkflowProjects(limit = 50, status?: string) {
  const read = useCallback(() => listWorkflowProjects({ limit, ...(status ? { status } : {}) }), [limit, status])

  return useWorkflowDomainRead(`projects:${limit}:${status ?? ''}`, read, Boolean(workflowDomainBridge()?.listProjects))
}

export function useWorkflowProject(projectId: string | undefined, reloadToken = 0) {
  const read = useCallback(() => projectId ? getWorkflowProject(projectId) : Promise.resolve({ mode: 'unavailable' } as WorkflowProjectOutcome), [projectId])

  return useWorkflowDomainRead(`project:${projectId ?? ''}`, read, Boolean(projectId && workflowDomainBridge()?.getProject), reloadToken)
}

export function useWorkflowProjectCompletion(projectId: string | undefined, reloadToken = 0) {
  const read = useCallback(() => projectId ? getWorkflowProjectCompletion(projectId) : Promise.resolve({ mode: 'unavailable' } as WorkflowProjectCompletionOutcome), [projectId])

  return useWorkflowDomainRead(`completion:${projectId ?? ''}`, read, Boolean(projectId && workflowDomainBridge()?.getProjectCompletion), reloadToken)
}

export function useWorkflowCatalog(reloadToken = 0): WorkflowCatalogState {
  const [state, setState] = useState<WorkflowCatalogState>(() =>
    workflowDomainBridge()?.getCatalog ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    setState({ mode: 'loading' })
    void listWorkflowCatalog().then(result => {
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

export function useVideoWorkflowCatalog(reloadToken = 0): WorkflowVideoCatalogState {
  const [state, setState] = useState<WorkflowVideoCatalogState>(() =>
    workflowDomainBridge()?.getVideoCatalog ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    setState({ mode: 'loading' })
    void listVideoWorkflowCatalog().then(result => {
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

export function useWorkflowDefinitions(
  options: { limit?: number; projectId?: string; status?: string } = {},
  reloadToken = 0
) {
  const { limit, projectId, status } = options
  const read = useCallback(() => listWorkflowDefinitions({ limit, projectId, status }), [limit, projectId, status])

  return useWorkflowDomainRead(`workflows:${limit ?? ''}:${projectId ?? ''}:${status ?? ''}`, read, Boolean(workflowDomainBridge()?.listWorkflows), reloadToken)
}
