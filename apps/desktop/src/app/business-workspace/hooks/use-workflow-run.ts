import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { cancelWorkflowRun, getWorkflowRun, retryWorkflowRunStep, reviewWorkflowDeliverable } from '../api/adapters'
import { $workflowDomainAccountScope, $workflowDomainRevision, workflowDomainUrgentRevision, workflowWindowIsViewed } from '../api/read-revision'
import type { WorkflowRunOverview } from '../api/types'
import { businessStatusPresentation } from '../view-model/display-status'

export interface WorkflowRunController {
  actionFailed: boolean
  actionId: null | string
  cancel: () => Promise<void>
  failed: boolean
  load: () => Promise<void>
  loading: boolean
  overview: null | WorkflowRunOverview
  retryStep: (stepKey: string) => Promise<void>
  review: (deliverableId: string, status: 'approved' | 'changes_requested') => Promise<void>
}

export const WORKFLOW_RUN_POLL_INTERVAL_MS = 3000

interface InFlightRunRequest {
  owner: string
  promise: Promise<void>
  runId: string
  urgent: number
}

/** Owns Run reads, polling, cancellation and Review mutations. */
export function useWorkflowRun(runId: string): WorkflowRunController {
  const revision = useStore($workflowDomainRevision)
  const owner = useStore($workflowDomainAccountScope)
  const revisionRef = useRef({ revision, urgent: workflowDomainUrgentRevision() })
  const [overview, setOverview] = useState<null | WorkflowRunOverview>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [actionId, setActionId] = useState<null | string>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const generationRef = useRef(0)
  const actionGenerationRef = useRef(0)
  const inFlightRef = useRef<InFlightRunRequest | null>(null)

  const refresh = useCallback(
    (force = false): Promise<void> => {
      const existing = inFlightRef.current
      const urgent = workflowDomainUrgentRevision()

      if (existing?.runId === runId && existing.owner === owner && (!force || existing.urgent === urgent)) {
        return existing.promise
      }

      const generation = ++generationRef.current

      const request = (async () => {
        try {
          const next = runId ? await getWorkflowRun(runId) : null

          if (generation !== generationRef.current || owner !== $workflowDomainAccountScope.get() || urgent !== workflowDomainUrgentRevision()) {
            return
          }

          if (!next) {
            setFailed(true)

            return
          }

          setOverview(next)
          setFailed(false)
        } catch {
          if (generation === generationRef.current && owner === $workflowDomainAccountScope.get() && urgent === workflowDomainUrgentRevision()) {
            setFailed(true)
          }
        } finally {
          if (generation === generationRef.current && owner === $workflowDomainAccountScope.get() && urgent === workflowDomainUrgentRevision()) {
            setLoading(false)
          }
        }
      })()

      inFlightRef.current = { owner, promise: request, runId, urgent }
      void request.finally(() => {
        if (inFlightRef.current?.promise === request) {
          inFlightRef.current = null
        }
      })

      return request
    },
    [owner, runId]
  )

  const load = useCallback(() => refresh(), [refresh])

  const invalidateRequests = useCallback(() => {
    generationRef.current += 1
    actionGenerationRef.current += 1
    inFlightRef.current = null
  }, [])

  useEffect(() => {
    invalidateRequests()
    setActionFailed(false)
    setActionId(null)
    setFailed(false)
    setLoading(true)
    setOverview(null)
    void load()

    return invalidateRequests
  }, [invalidateRequests, load])

  // Consumed invalidation cursor; response ownership always reads the authoritative atom.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (revisionRef.current.revision !== revision) {
      const urgent = workflowDomainUrgentRevision()
      const force = revisionRef.current.urgent !== urgent
      revisionRef.current = { revision, urgent }
      void refresh(force)
    }
  }, [refresh, revision])

  const shouldPoll = Boolean(overview && businessStatusPresentation('run', overview.run.status).poll)

  useEffect(() => {
    if (!shouldPoll) {
      return
    }

    let timer: null | number = null

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }

    const schedule = () => {
      stop()

      if (workflowWindowIsViewed()) {
        timer = window.setInterval(() => void load(), WORKFLOW_RUN_POLL_INTERVAL_MS)
      }
    }

    const sync = () => {
      // Shared reconciliation owns the immediate read on return, including terminal Runs.
      schedule()
    }

    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    schedule()

    return () => {
      stop()
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [load, shouldPoll])

  const cancel = async () => {
    const action = ++actionGenerationRef.current
    const currentAction = () => action === actionGenerationRef.current && owner === $workflowDomainAccountScope.get()
    setActionFailed(false)
    setActionId('cancel')

    try {
      if (!(await cancelWorkflowRun(runId))) {
        if (currentAction()) {setActionFailed(true)}

        return
      }

      if (currentAction()) {await refresh(true)}
    } catch {
      if (currentAction()) {setActionFailed(true)}
    } finally {
      if (currentAction()) {setActionId(null)}
    }
  }

  const review = async (deliverableId: string, status: 'approved' | 'changes_requested') => {
    const action = ++actionGenerationRef.current
    const currentAction = () => action === actionGenerationRef.current && owner === $workflowDomainAccountScope.get()
    setActionFailed(false)
    setActionId(`${deliverableId}:${status}`)

    try {
      if (!(await reviewWorkflowDeliverable(deliverableId, status))) {
        if (currentAction()) {setActionFailed(true)}

        return
      }

      if (currentAction()) {await refresh(true)}
    } catch {
      if (currentAction()) {setActionFailed(true)}
    } finally {
      if (currentAction()) {setActionId(null)}
    }
  }

  const retryStep = async (stepKey: string) => {
    const action = ++actionGenerationRef.current
    const currentAction = () => action === actionGenerationRef.current && owner === $workflowDomainAccountScope.get()
    setActionFailed(false)
    setActionId(`step:${stepKey}:retry`)

    try {
      if (!(await retryWorkflowRunStep(runId, stepKey))) {
        if (currentAction()) {setActionFailed(true)}

        return
      }

      if (currentAction()) {await refresh(true)}
    } catch {
      if (currentAction()) {setActionFailed(true)}
    } finally {
      if (currentAction()) {setActionId(null)}
    }
  }

  return { actionFailed, actionId, cancel, failed, load, loading, overview, retryStep, review }
}
