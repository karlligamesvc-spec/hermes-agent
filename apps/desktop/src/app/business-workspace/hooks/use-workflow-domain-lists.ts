import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import {
  getWorkflowProject,
  getWorkflowProjectCompletion,
  listVideoWorkflowCatalog,
  listWorkflowCatalog,
  listWorkflowDefinitions,
  listWorkflowProjects,
  type WorkflowCatalogOutcome,
  type WorkflowDefinitionListOutcome,
  type WorkflowProjectCompletionOutcome,
  type WorkflowProjectListOutcome,
  type WorkflowProjectOutcome,
  type WorkflowVideoCatalogOutcome
} from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'
import { $workflowDomainRevision } from '../api/read-revision'

type ProjectListState = WorkflowProjectListOutcome | { mode: 'loading' }
type ProjectState = WorkflowProjectOutcome | { mode: 'loading' }
type ProjectCompletionState = WorkflowProjectCompletionOutcome | { mode: 'loading' }
type WorkflowCatalogState = WorkflowCatalogOutcome | { mode: 'loading' }
type WorkflowVideoCatalogState = WorkflowVideoCatalogOutcome | { mode: 'loading' }
type WorkflowListState = WorkflowDefinitionListOutcome | { mode: 'loading' }

export function useWorkflowProjects(limit = 50, status?: string): ProjectListState {
  const revision = useStore($workflowDomainRevision)

  const [state, setState] = useState<ProjectListState>(() =>
    workflowDomainBridge()?.listProjects ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    void listWorkflowProjects({ limit, ...(status ? { status } : {}) }).then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [limit, revision, status])

  return state
}

export function useWorkflowProject(projectId: string | undefined, reloadToken = 0): ProjectState {
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
  }, [projectId, reloadToken])

  return state
}

export function useWorkflowProjectCompletion(projectId: string | undefined, reloadToken = 0): ProjectCompletionState {
  const [state, setState] = useState<ProjectCompletionState>(() =>
    projectId && workflowDomainBridge()?.getProjectCompletion ? { mode: 'loading' } : { mode: 'unavailable' }
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
    void getWorkflowProjectCompletion(projectId).then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [projectId, reloadToken])

  return state
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
): WorkflowListState {
  const revision = useStore($workflowDomainRevision)

  const [state, setState] = useState<WorkflowListState>(() =>
    workflowDomainBridge()?.listWorkflows ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  const { limit, projectId, status } = options

  useEffect(() => {
    let active = true

    setState({ mode: 'loading' })
    void listWorkflowDefinitions({ limit, projectId, status }).then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [limit, projectId, reloadToken, revision, status])

  return state
}
