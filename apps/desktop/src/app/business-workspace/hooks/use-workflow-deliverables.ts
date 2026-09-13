import { useCallback, useEffect, useState } from 'react'

import {
  getWorkflowDeliverable,
  listWorkflowActivity,
  listWorkflowDeliverables,
  type WorkflowActivityListOutcome,
  type WorkflowDeliverableDetailOutcome,
  type WorkflowDeliverableListOutcome
} from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'
import type { WorkflowActivityItem, WorkflowDeliverable } from '../api/types'

type DeliverableState =
  | { mode: 'failed' }
  | { mode: 'loading' }
  | { mode: 'unavailable' }
  | {
      items: WorkflowDeliverable[]
      loadingMore: boolean
      mode: 'ready'
      moreFailed: boolean
      nextCursor: null | string
      scope: string
    }

type DeliverableDetailState = WorkflowDeliverableDetailOutcome | { mode: 'loading' }

type ActivityState =
  | { mode: 'failed' }
  | { mode: 'loading' }
  | { mode: 'unavailable' }
  | {
      items: WorkflowActivityItem[]
      loadingMore: boolean
      mode: 'ready'
      moreFailed: boolean
      nextCursor: null | string
      scope: string
    }

function readyDeliverables(result: WorkflowDeliverableListOutcome, scope: string): DeliverableState {
  return result.mode === 'ready'
    ? {
        items: result.items,
        loadingMore: false,
        mode: 'ready',
        moreFailed: false,
        nextCursor: result.nextCursor,
        scope
      }
    : result
}

function readyActivity(result: WorkflowActivityListOutcome, scope: string): ActivityState {
  return result.mode === 'ready'
    ? {
        items: result.items,
        loadingMore: false,
        mode: 'ready',
        moreFailed: false,
        nextCursor: result.nextCursor,
        scope
      }
    : result
}

export function useWorkflowDeliverables(options: { kind?: string; status?: string } = {}) {
  const { kind, status } = options
  const [reloadToken, setReloadToken] = useState(0)
  const scope = `${kind ?? ''}\0${status ?? ''}\0${reloadToken}`

  const [state, setState] = useState<DeliverableState>(() =>
    workflowDomainBridge()?.listDeliverables ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true
    setState({ mode: 'loading' })

    void listWorkflowDeliverables({ kind, limit: 50, status }).then(result => {
      if (active) {
        setState(readyDeliverables(result, scope))
      }
    })

    return () => {
      active = false
    }
  }, [kind, reloadToken, scope, status])

  const loadMore = useCallback(async () => {
    const snapshot = state

    if (snapshot.mode !== 'ready' || snapshot.loadingMore || !snapshot.nextCursor) {
      return
    }

    setState({ ...snapshot, loadingMore: true, moreFailed: false })
    const result = await listWorkflowDeliverables({ cursor: snapshot.nextCursor, kind, limit: 50, status })

    setState(current => {
      if (current.mode === 'ready' && current.scope !== snapshot.scope) {
        return current
      }

      if (current.mode !== 'ready') {
        return current
      }

      if (result.mode !== 'ready') {
        return { ...current, loadingMore: false, moreFailed: true }
      }

      const seen = new Set(current.items.map(item => item.id))

      return {
        items: [...current.items, ...result.items.filter(item => !seen.has(item.id))],
        loadingMore: false,
        mode: 'ready',
        moreFailed: false,
        nextCursor: result.nextCursor,
        scope: current.scope
      }
    })
  }, [kind, state, status])

  return { loadMore, refresh: () => setReloadToken(token => token + 1), state }
}

export function useWorkflowDeliverable(deliverableId: string | undefined, reloadToken = 0): DeliverableDetailState {
  const [state, setState] = useState<DeliverableDetailState>(() =>
    deliverableId && workflowDomainBridge()?.getDeliverable ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true

    if (!deliverableId) {
      setState({ mode: 'unavailable' })

      return () => {
        active = false
      }
    }

    setState({ mode: 'loading' })
    void getWorkflowDeliverable(deliverableId).then(result => {
      if (active) {
        setState(result)
      }
    })

    return () => {
      active = false
    }
  }, [deliverableId, reloadToken])

  return state
}

export function useWorkflowActivity(kinds?: string) {
  const [reloadToken, setReloadToken] = useState(0)
  const scope = `${kinds ?? ''}\0${reloadToken}`

  const [state, setState] = useState<ActivityState>(() =>
    workflowDomainBridge()?.listActivity ? { mode: 'loading' } : { mode: 'unavailable' }
  )

  useEffect(() => {
    let active = true
    setState({ mode: 'loading' })

    void listWorkflowActivity({ kinds, limit: 50 }).then(result => {
      if (active) {
        setState(readyActivity(result, scope))
      }
    })

    return () => {
      active = false
    }
  }, [kinds, reloadToken, scope])

  const loadMore = useCallback(async () => {
    const snapshot = state

    if (snapshot.mode !== 'ready' || snapshot.loadingMore || !snapshot.nextCursor) {
      return
    }

    setState({ ...snapshot, loadingMore: true, moreFailed: false })
    const result = await listWorkflowActivity({ cursor: snapshot.nextCursor, kinds, limit: 50 })

    setState(current => {
      if (current.mode === 'ready' && current.scope !== snapshot.scope) {
        return current
      }

      if (current.mode !== 'ready') {
        return current
      }

      if (result.mode !== 'ready') {
        return { ...current, loadingMore: false, moreFailed: true }
      }

      const seen = new Set(current.items.map(item => item.id))

      return {
        items: [...current.items, ...result.items.filter(item => !seen.has(item.id))],
        loadingMore: false,
        mode: 'ready',
        moreFailed: false,
        nextCursor: result.nextCursor,
        scope: current.scope
      }
    })
  }, [kinds, state])

  return { loadMore, refresh: () => setReloadToken(token => token + 1), state }
}
