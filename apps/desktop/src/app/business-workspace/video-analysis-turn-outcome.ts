import { requestGatewayForAgent } from '@/store/gateway'

import { type AnalysisChatLink, sameAnalysisChatLink, validAnalysisTurnState } from '../../../shared/analysis-chat-link'

import type { AnalysisDocument, AnalysisDocumentsBridge } from './analysis-types'
import { analysisChatContextMatches } from './video-analysis-chat-handoff'

/** Only this accepted runtime attempt is queried. Missing runtime/history never implies success. */
export async function refreshAnalysisTurnOutcome(source: AnalysisDocument, link: AnalysisChatLink, bridge: AnalysisDocumentsBridge, isCurrent: () => boolean): Promise<AnalysisChatLink> {
  if (!link.turn || !bridge.readDeepChat || !bridge.updateDeepChatOutcome || !isCurrent() || !analysisChatContextMatches(link)) {
    throw new Error('analysis_context_changed')
  }

  const current = await bridge.readDeepChat(source.id, source.analysis_scope!, source.analysis_revision!)

  if (!current.ok || !sameAnalysisChatLink(current.item, link) || !isCurrent() || !analysisChatContextMatches(link)) {throw new Error('analysis_context_changed')}
  let result: { turn_id?: string; status?: unknown }

  try {
    result = await requestGatewayForAgent(link.connectionId, link.profile, 'prompt.turn.status', {
      session_id: link.turn.runtimeSessionId, turn_id: link.turn.id
    })
  } catch (error) {
    // A reaped runtime or older gateway has no outcome for this attempt. Other errors stay retryable.
    const code = (error as { code?: number }).code

    if (code !== 4001 && code !== -32601) {throw error}
    result = { turn_id: link.turn.id, status: 'unavailable' }
  }

  if (result?.turn_id !== link.turn.id || !validAnalysisTurnState(result.status)) {throw new Error('analysis_turn_invalid')}

  if (!isCurrent() || !analysisChatContextMatches(link)) {throw new Error('analysis_context_changed')}
  const saved = await bridge.updateDeepChatOutcome(source.id, source.analysis_scope!, source.analysis_revision!, link, result.status)

  if (!saved.ok || !saved.item || !sameAnalysisChatLink(saved.item, link)) {throw new Error('analysis_context_changed')}

  return saved.item
}
