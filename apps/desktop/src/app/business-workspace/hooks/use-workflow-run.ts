import { useCallback, useEffect, useState } from 'react'

import {
  cancelWorkflowRun,
  getWorkflowRun,
  reviewWorkflowDeliverable
} from '../api/adapters'
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
  review: (deliverableId: string, status: 'approved' | 'changes_requested') => Promise<void>
}

/** Owns Run reads, polling, cancellation and Review mutations. */
export function useWorkflowRun(runId: string): WorkflowRunController {
  const [overview, setOverview] = useState<null | WorkflowRunOverview>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [actionId, setActionId] = useState<null | string>(null)
  const [actionFailed, setActionFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)

    try {
      const next = runId ? await getWorkflowRun(runId) : null

      if (!next) {
        setFailed(true)

        return
      }

      setOverview(next)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!overview || !businessStatusPresentation('run', overview.run.status).poll) {
      return
    }

    const timer = window.setInterval(() => void load(), 3000)

    return () => window.clearInterval(timer)
  }, [load, overview])

  const cancel = async () => {
    setActionFailed(false)
    setActionId('cancel')

    try {
      if (!(await cancelWorkflowRun(runId))) {
        setActionFailed(true)

        return
      }

      await load()
    } catch {
      setActionFailed(true)
    } finally {
      setActionId(null)
    }
  }

  const review = async (deliverableId: string, status: 'approved' | 'changes_requested') => {
    setActionFailed(false)
    setActionId(`${deliverableId}:${status}`)

    try {
      if (!(await reviewWorkflowDeliverable(deliverableId, status))) {
        setActionFailed(true)

        return
      }

      await load()
    } catch {
      setActionFailed(true)
    } finally {
      setActionId(null)
    }
  }

  return { actionFailed, actionId, cancel, failed, load, loading, overview, review }
}
