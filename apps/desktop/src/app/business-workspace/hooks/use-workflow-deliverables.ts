import { useCallback } from 'react'

import { getWorkflowDeliverable, listWorkflowActivity, listWorkflowDeliverables, type WorkflowDeliverableDetailOutcome } from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'

import { useWorkflowDomainPages } from './use-workflow-domain-pages'
import { useWorkflowDomainRead } from './use-workflow-domain-read'

export function useWorkflowDeliverables(options: { kind?: string; status?: string } = {}) {
  const { kind, status } = options
  const read = useCallback((cursor?: string) => listWorkflowDeliverables({ ...(cursor ? { cursor } : {}), kind, limit: 50, status }), [kind, status])

  return useWorkflowDomainPages(`deliverables:${kind ?? ''}:${status ?? ''}`, read, Boolean(workflowDomainBridge()?.listDeliverables))
}

export function useWorkflowDeliverable(deliverableId: string | undefined, reloadToken = 0) {
  const read = useCallback(() => deliverableId ? getWorkflowDeliverable(deliverableId) : Promise.resolve({ mode: 'unavailable' } as WorkflowDeliverableDetailOutcome), [deliverableId])

  return useWorkflowDomainRead(`deliverable:${deliverableId ?? ''}`, read, Boolean(deliverableId && workflowDomainBridge()?.getDeliverable), reloadToken)
}

export function useWorkflowActivity(kinds?: string) {
  const read = useCallback((cursor?: string) => listWorkflowActivity({ ...(cursor ? { cursor } : {}), kinds, limit: 50 }), [kinds])

  return useWorkflowDomainPages(`activity:${kinds ?? ''}`, read, Boolean(workflowDomainBridge()?.listActivity))
}
