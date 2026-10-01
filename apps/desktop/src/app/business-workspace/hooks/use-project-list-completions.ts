import { useStore } from '@nanostores/react'
import { useCallback } from 'react'

import { getWorkflowProjectCompletion, type WorkflowProjectCompletionOutcome } from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'
import { $workflowDomainAccountScope, $workflowDomainRevision, workflowDomainUrgentRevision } from '../api/read-revision'

import { useWorkflowDomainRead } from './use-workflow-domain-read'

// Share current owner/revision reads across list instances, keeping at most four HTTP reads in flight.
let cacheScope = ''
const reads = new Map<string, Promise<WorkflowProjectCompletionOutcome>>()
let active = 0
const queue: Array<() => void> = []

function readCompletion(id: string, scope: string, isCurrent: () => boolean): Promise<WorkflowProjectCompletionOutcome> {
  if (scope !== cacheScope) {cacheScope = scope; reads.clear()}
  const existing = reads.get(id)

  if (existing) {return existing}

  const work = new Promise<WorkflowProjectCompletionOutcome>(resolve => {
    const run = async () => {
      active += 1
      let result: WorkflowProjectCompletionOutcome

      try {result = isCurrent() ? await getWorkflowProjectCompletion(id) : { mode: 'unavailable' }}
      catch {result = { mode: 'failed' }}

      active -= 1
      queue.shift()?.()
      resolve(result)
    }

    const start = () => {void run()}

    if (active < 4) {start()} else {queue.push(start)}
  })

  reads.set(id, work)
  void work.then(result => {
    if (result.mode !== 'ready' && scope === cacheScope && reads.get(id) === work) {reads.delete(id)}
  })

  return work
}

/** Reads only the currently loaded Projects; failures remain explicit unknown classifications. */
export function useProjectListCompletions(projectIds: string[]) {
  const owner = useStore($workflowDomainAccountScope)
  const idsKey = JSON.stringify(projectIds)

  const read = useCallback(async () => {
    const revision = $workflowDomainRevision.get()
    const urgent = workflowDomainUrgentRevision()
    const scope = `${owner}:${revision}:${urgent}`
    const isCurrent = () => owner === $workflowDomainAccountScope.get() && urgent === workflowDomainUrgentRevision()
    const ids = JSON.parse(idsKey) as string[]
    const entries = await Promise.all(ids.map(async id => [id, await readCompletion(id, scope, isCurrent)] as const))

    return { items: new Map(entries), mode: 'ready' as const }
  }, [idsKey, owner])

  const state = useWorkflowDomainRead(`project-list-completion:${idsKey}`, read, Boolean(workflowDomainBridge()?.getProjectCompletion))

  return { ...state, refreshFailed: state.refreshFailed || (state.mode === 'ready' && [...state.items.values()].some(result => result.mode === 'failed')) }
}
