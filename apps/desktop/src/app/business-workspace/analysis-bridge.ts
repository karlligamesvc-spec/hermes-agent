import type { AnalysisChatLink } from '../../../shared/analysis-chat-link'

import type { AnalysisDocumentsBridge } from './analysis-types'
import { captureWorkflowMutationScope } from './api/mutation-scope'
import { workflowDomainChanged } from './api/read-revision'

const writes = [
  'importFile', 'importLink', 'transcribeVideoLink', 'uploadVideo',
  'authorizeFeishu', 'pollFeishu', 'forgetFeishu',
  'importDeepReport', 'prepareDeepWorkspace', 'recordDeepChat', 'updateDeepChatOutcome',
  'collectDeepReport', 'reviewDeepReport', 'deleteDeepReport',
  'saveOverview', 'saveAnswer', 'ask', 'addNote', 'deleteNote', 'retry', 'delete'
] as const satisfies readonly (keyof AnalysisDocumentsBridge)[]

const bridges = new WeakMap<AnalysisDocumentsBridge, AnalysisDocumentsBridge>()

/** Invalidation carries no source data; each window re-reads its own account. */
export function analysisDocumentsBridge(): AnalysisDocumentsBridge | null {
  const original = window.hermesDesktop?.analysisDocuments

  if (!original) {return null}
  const existing = bridges.get(original)

  if (existing) {return existing}
  const wrapped = Object.create(original) as AnalysisDocumentsBridge

  for (const name of writes) {
    const method = original[name]

    if (!method) {continue}
    Object.defineProperty(wrapped, name, { value: async (...args: unknown[]) => {
      const isCurrent = captureWorkflowMutationScope()
      const result = await (method as (...values: unknown[]) => Promise<{ ok: boolean; status?: string; item?: AnalysisChatLink }>).apply(original, args)

      if (!isCurrent()) {return { ok: false, code: 'account_changed' }}

      const changed = name === 'pollFeishu' ? result.status === 'authorized'
        : name === 'updateDeepChatOutcome' ? result.item?.outcome?.status !== (args[3] as AnalysisChatLink | undefined)?.outcome?.status
          : true

      if (result.ok && changed) {workflowDomainChanged()}

      return result
    } })
  }

  bridges.set(original, wrapped)

  return wrapped
}
