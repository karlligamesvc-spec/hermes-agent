import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { $workflowDomainAccountScope, $workflowDomainRevision, workflowDomainUrgentRevision } from '../api/read-revision'

import type { WorkflowReadRecovery } from './use-workflow-domain-read'

type PageResult<T> =
  | { items: T[]; mode: 'ready'; nextCursor: string | null }
  | { mode: 'failed' }
  | { mode: 'unavailable' }

interface ReadyPages<T> {
  items: T[]
  loadingMore: boolean
  mode: 'ready'
  moreFailed: boolean
  nextCursor: string | null
}

interface PageEntry<T> {
  owner: string
  refreshFailed: boolean
  refreshing: boolean
  result: ReadyPages<T> | { mode: 'failed' } | { mode: 'loading' } | { mode: 'unavailable' }
  scope: string
}

/** Refresh the loaded page chain so edits, deletions and new cursors remain authoritative. */
export function useWorkflowDomainPages<T extends { id: string }>(
  scope: string,
  readPage: (cursor?: string) => Promise<PageResult<T>>,
  available: boolean
) {
  const revision = useStore($workflowDomainRevision)
  const owner = useStore($workflowDomainAccountScope)
  const [retryToken, setRetryToken] = useState(0)
  const retry = useCallback(() => setRetryToken(token => token + 1), [])
  const generation = useRef(0)
  const pending = useRef<Promise<void> | null>(null)
  const pageRequest = useRef(false)
  const seen = useRef({ retryToken, revision, urgent: workflowDomainUrgentRevision() })
  const loadedPageCount = useRef(1)

  const [entry, setEntry] = useState<PageEntry<T>>(() => ({
    owner, refreshFailed: false, refreshing: false, result: { mode: available ? 'loading' : 'unavailable' }, scope
  }))

  const refresh = useCallback((force = false): Promise<void> => {
    if (!force && (pending.current || pageRequest.current)) {return pending.current ?? Promise.resolve()}
    const request = ++generation.current
    const urgent = workflowDomainUrgentRevision()
    pageRequest.current = false
    const currentRequest = () => request === generation.current && owner === $workflowDomainAccountScope.get() && urgent === workflowDomainUrgentRevision()
    const count = loadedPageCount.current
    setEntry(current => available && current.scope === scope && current.owner === owner && current.result.mode === 'ready'
      ? { ...current, refreshing: true, result: { ...current.result, loadingMore: false } }
      : { owner, refreshFailed: false, refreshing: false, result: { mode: available ? 'loading' : 'unavailable' }, scope })

    const work = (async () => {
      const items: T[] = []
      let cursor: string | undefined
      let result: PageResult<T> = { mode: available ? 'failed' : 'unavailable' }
      let pagesRead = 0

      try {
        for (let index = 0; available && index < count; index++) {
          result = await readPage(cursor)

          if (!currentRequest()) {return}

          if (result.mode !== 'ready') {break}
          const ids = new Set(items.map(item => item.id))
          items.push(...result.items.filter(item => !ids.has(item.id)))
          pagesRead += 1

          if (!result.nextCursor) {break}
          cursor = result.nextCursor
        }
      } catch {result = { mode: 'failed' }}

      if (!currentRequest()) {return}

      if (result.mode === 'ready') {
        loadedPageCount.current = pagesRead
        setEntry({ owner, refreshFailed: false, refreshing: false,
          result: { items, loadingMore: false, mode: 'ready', moreFailed: false, nextCursor: result.nextCursor }, scope })
      } else {
        const failure = result
        setEntry(current => failure.mode === 'failed' && current.owner === owner && current.scope === scope && current.result.mode === 'ready'
          ? { ...current, refreshFailed: true, refreshing: false }
          : { owner, refreshFailed: failure.mode === 'failed', refreshing: false, result: failure, scope })
      }
    })()

    pending.current = work
    void work.finally(() => {if (pending.current === work) {pending.current = null}})

    return work
  }, [available, owner, readPage, scope])

  // Request lifecycle tokens; authoritative account identity is checked with $atom.get().
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    generation.current += 1
    pending.current = null
    pageRequest.current = false
    loadedPageCount.current = 1
    setEntry({ owner, refreshFailed: false, refreshing: false, result: { mode: available ? 'loading' : 'unavailable' }, scope })
    void refresh()

    return () => {generation.current += 1; pending.current = null; pageRequest.current = false}
  }, [available, owner, refresh, scope])

  // Track consumed invalidations, not an identity snapshot used by asynchronous callbacks.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const urgent = workflowDomainUrgentRevision()
    const forced = seen.current.urgent !== urgent || seen.current.retryToken !== retryToken
    const changed = seen.current.revision !== revision || forced
    seen.current = { retryToken, revision, urgent }

    if (changed) {void refresh(forced)}
  }, [refresh, retryToken, revision])

  const loadMore = useCallback(async () => {
    const snapshot = entry.result

    if (entry.owner !== owner || entry.scope !== scope || entry.refreshing || snapshot.mode !== 'ready' || pageRequest.current || !snapshot.nextCursor) {return}
    const request = generation.current
    const urgent = workflowDomainUrgentRevision()
    pageRequest.current = true
    setEntry(current => current.result.mode === 'ready'
      ? { ...current, result: { ...current.result, loadingMore: true, moreFailed: false } } : current)
    let result: PageResult<T>

    try {result = await readPage(snapshot.nextCursor)} catch {result = { mode: 'failed' }}

    if (request !== generation.current || urgent !== workflowDomainUrgentRevision() || owner !== $workflowDomainAccountScope.get()) {return}
    pageRequest.current = false

    if (result.mode === 'ready') {loadedPageCount.current += 1}
    setEntry(current => {
      if (current.owner !== owner || current.scope !== scope || current.result.mode !== 'ready') {return current}

      if (result.mode !== 'ready') {return { ...current, result: { ...current.result, loadingMore: false, moreFailed: true } }}
      const ids = new Set(current.result.items.map(item => item.id))

      return { ...current, result: { items: [...current.result.items, ...result.items.filter(item => !ids.has(item.id))],
        loadingMore: false, mode: 'ready', moreFailed: false, nextCursor: result.nextCursor } }
    })
  }, [entry, owner, readPage, scope])

  const recovery: WorkflowReadRecovery = { refreshFailed: entry.refreshFailed, refreshing: entry.refreshing, retry }

  const state = entry.owner === owner && entry.scope === scope
    ? { ...entry.result, ...recovery }
    : available
      ? { mode: 'loading' as const, refreshFailed: false, refreshing: false, retry }
      : { mode: 'unavailable' as const, refreshFailed: false, refreshing: false, retry }

  return { loadMore, refresh: retry, state }
}
