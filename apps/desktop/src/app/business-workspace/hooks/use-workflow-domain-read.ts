import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { $workflowDomainAccountScope, $workflowDomainRevision, workflowDomainUrgentRevision } from '../api/read-revision'

export interface WorkflowReadRecovery {
  refreshFailed: boolean
  refreshing: boolean
  retry: () => void
}

interface ReadEntry<T> {
  owner: string
  refreshFailed: boolean
  refreshing: boolean
  result: T | { mode: 'loading' }
  scope: string
}

/** Reconciles a mutable server projection without replacing confirmed data with a read failure. */
export function useWorkflowDomainRead<T extends { mode: string }>(
  scope: string,
  read: () => Promise<T>,
  available: boolean,
  reloadToken = 0
): (T | { mode: 'loading' }) & WorkflowReadRecovery {
  const revision = useStore($workflowDomainRevision)
  const owner = useStore($workflowDomainAccountScope)
  const generation = useRef(0)
  const pending = useRef<Promise<void> | null>(null)
  const seen = useRef({ reloadToken, retryToken: 0, revision, urgent: workflowDomainUrgentRevision() })
  const [retryToken, setRetryToken] = useState(0)
  const retry = useCallback(() => setRetryToken(token => token + 1), [])

  const [entry, setEntry] = useState<ReadEntry<T>>(() => ({
    owner, refreshFailed: false, refreshing: false,
    result: available ? { mode: 'loading' } : { mode: 'unavailable' } as T, scope
  }))

  const refresh = useCallback((force = false): Promise<void> => {
    if (!force && pending.current) {return pending.current}
    const request = ++generation.current
    const urgent = workflowDomainUrgentRevision()
    setEntry(current => available && current.scope === scope && current.owner === owner && current.result.mode === 'ready'
      ? { ...current, refreshing: true }
      : { owner, refreshFailed: false, refreshing: false, result: { mode: available ? 'loading' : 'unavailable' } as T, scope })

    const work = (async () => {
      let result: T

      try {result = available ? await read() : { mode: 'unavailable' } as T}
      catch {result = { mode: 'failed' } as T}

      if (request !== generation.current || owner !== $workflowDomainAccountScope.get() || urgent !== workflowDomainUrgentRevision()) {return}
      setEntry(current => result.mode === 'failed' && current.owner === owner && current.scope === scope && current.result.mode === 'ready'
        ? { ...current, refreshFailed: true, refreshing: false }
        : { owner, refreshFailed: result.mode === 'failed', refreshing: false, result, scope })
    })()

    pending.current = work
    void work.finally(() => {if (pending.current === work) {pending.current = null}})

    return work
  }, [available, owner, read, scope])

  // Request lifecycle tokens; authoritative account identity is checked with $atom.get().
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    generation.current += 1
    pending.current = null
    setEntry({ owner, refreshFailed: false, refreshing: false, result: { mode: available ? 'loading' : 'unavailable' } as T, scope })
    void refresh()

    return () => {generation.current += 1; pending.current = null}
  }, [available, owner, refresh, scope])

  // Track consumed invalidations, not an identity snapshot used by asynchronous callbacks.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const urgent = workflowDomainUrgentRevision()
    const forced = seen.current.urgent !== urgent || seen.current.reloadToken !== reloadToken || seen.current.retryToken !== retryToken
    const changed = seen.current.revision !== revision || forced
    seen.current = { reloadToken, retryToken, revision, urgent }

    if (changed) {void refresh(forced)}
  }, [refresh, reloadToken, retryToken, revision])

  if (entry.owner !== owner || entry.scope !== scope) {
    return { mode: available ? 'loading' : 'unavailable', refreshFailed: false, refreshing: false, retry } as (T | { mode: 'loading' }) & WorkflowReadRecovery
  }

  return { ...entry.result, refreshFailed: entry.refreshFailed, refreshing: entry.refreshing, retry }
}
