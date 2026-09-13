import { useCallback, useEffect, useRef, useState } from 'react'

import { cancelWorkflowRun, getWorkflowRun, reviewWorkflowDeliverable } from '../api/adapters'
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

export const WORKFLOW_RUN_POLL_INTERVAL_MS = 3000

interface InFlightRunRequest {
  promise: Promise<void>
  runId: string
}

function windowIsActivelyViewed(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Owns Run reads, polling, cancellation and Review mutations. */
export function useWorkflowRun(runId: string): WorkflowRunController {
  const [overview, setOverview] = useState<null | WorkflowRunOverview>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [actionId, setActionId] = useState<null | string>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const generationRef = useRef(0)
  const inFlightRef = useRef<InFlightRunRequest | null>(null)

  const refresh = useCallback(
    (force = false): Promise<void> => {
      const existing = inFlightRef.current

      if (!force && existing?.runId === runId) {
        return existing.promise
      }

      const generation = ++generationRef.current

      const request = (async () => {
        try {
          const next = runId ? await getWorkflowRun(runId) : null

          if (generation !== generationRef.current) {
            return
          }

          if (!next) {
            setFailed(true)

            return
          }

          setOverview(next)
          setFailed(false)
        } catch {
          if (generation === generationRef.current) {
            setFailed(true)
          }
        } finally {
          if (generation === generationRef.current) {
            setLoading(false)
          }
        }
      })()

      inFlightRef.current = { promise: request, runId }
      void request.finally(() => {
        if (inFlightRef.current?.promise === request) {
          inFlightRef.current = null
        }
      })

      return request
    },
    [runId]
  )

  const load = useCallback(() => refresh(), [refresh])

  const invalidateRequests = useCallback(() => {
    generationRef.current += 1
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

  const shouldPoll = Boolean(overview && businessStatusPresentation('run', overview.run.status).poll)

  useEffect(() => {
    if (!shouldPoll) {
      return
    }

    let timer: null | number = null
    let wasViewed = windowIsActivelyViewed()

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }

    const schedule = () => {
      stop()

      if (windowIsActivelyViewed()) {
        timer = window.setInterval(() => void load(), WORKFLOW_RUN_POLL_INTERVAL_MS)
      }
    }

    const sync = () => {
      const viewed = windowIsActivelyViewed()

      if (viewed && !wasViewed) {
        void load()
      }

      wasViewed = viewed
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
    setActionFailed(false)
    setActionId('cancel')

    try {
      if (!(await cancelWorkflowRun(runId))) {
        setActionFailed(true)

        return
      }

      await refresh(true)
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

      await refresh(true)
    } catch {
      setActionFailed(true)
    } finally {
      setActionId(null)
    }
  }

  return { actionFailed, actionId, cancel, failed, load, loading, overview, review }
}
