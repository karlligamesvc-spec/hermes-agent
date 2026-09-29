import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { requestGatewayForAgent } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { setConnection } from '@/store/session'

import type { AnalysisChatLink, AnalysisTurnState } from '../../../shared/analysis-chat-link'

import type { AnalysisDocument, AnalysisDocumentsBridge } from './analysis-types'
import { refreshAnalysisTurnOutcome } from './video-analysis-turn-outcome'

vi.mock('@/store/gateway', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), requestGatewayForAgent: vi.fn() }))
const source: AnalysisDocument = { id: 'source', analysis_scope: 'owner', analysis_revision: 'rev', filename: 'source.srt', kind: 'subtitle', status: 'ready', storageMode: 'local' }
const link: AnalysisChatLink = { sessionId: 'stored', connectionId: 'local', profile: 'worker', submittedAt: '2026-09-29T00:00:00Z', turn: { id: 'turn-one', runtimeSessionId: 'runtime' } }

function bridge() {
  return { readDeepChat: vi.fn(async () => ({ ok: true, item: link })), updateDeepChatOutcome: vi.fn(async (_id: string, _scope: string, _revision: string, _link: AnalysisChatLink, status: AnalysisTurnState) => ({ ok: true, item: { ...link, outcome: { status, observedAt: '2026-09-29T00:01:00Z' } } })) }
}

beforeEach(() => {setConnection({ connectionId: 'local', mode: 'local', baseUrl: 'http://127.0.0.1', wsUrl: 'ws://127.0.0.1', token: '', logs: [], isFullscreen: false, nativeOverlayWidth: 0, windowButtonPosition: null }); $activeGatewayProfile.set('worker'); vi.mocked(requestGatewayForAgent).mockReset()})
afterEach(() => {setConnection(null); $activeGatewayProfile.set('default')})
it.each(['complete', 'error', 'interrupted', 'running', 'unavailable'] as const)('saves the actual %s outcome on the exact source attempt', async status => {
  const api = bridge()
  vi.mocked(requestGatewayForAgent).mockResolvedValue({ turn_id: 'turn-one', status })
  const result = await refreshAnalysisTurnOutcome(source, link, api as unknown as AnalysisDocumentsBridge, () => true)
  expect(requestGatewayForAgent).toHaveBeenCalledExactlyOnceWith('local', 'worker', 'prompt.turn.status', { session_id: 'runtime', turn_id: 'turn-one' })
  expect(api.updateDeepChatOutcome).toHaveBeenCalledExactlyOnceWith('source', 'owner', 'rev', link, status)
  expect(result.outcome?.status).toBe(status)
})
it.each(['turn', 'status', 'unmounted', 'profile', 'source'] as const)('rejects a mismatched or late outcome: %s', async mode => {
  const api = bridge()
  let active = true
  vi.mocked(requestGatewayForAgent).mockImplementation(async () => {
    if (mode === 'unmounted') {active = false}

    if (mode === 'profile') {$activeGatewayProfile.set('other')}

    return { turn_id: mode === 'turn' ? 'another-turn' : 'turn-one', status: mode === 'status' ? 'idle' : 'complete' }
  })

  if (mode === 'source') {api.readDeepChat.mockResolvedValue({ ok: true, item: { ...link, turn: { id: 'another-turn', runtimeSessionId: 'runtime' } } })}
  await expect(refreshAnalysisTurnOutcome(source, link, api as unknown as AnalysisDocumentsBridge, () => active)).rejects.toThrow()
  expect(api.updateDeepChatOutcome).not.toHaveBeenCalled()
})
it.each([4001, -32601, 5000])('distinguishes missing runtime/capability from a transport error: %s', async code => {
  const api = bridge()
  vi.mocked(requestGatewayForAgent).mockRejectedValue(Object.assign(new Error('rpc failed'), { code }))
  const action = refreshAnalysisTurnOutcome(source, link, api as unknown as AnalysisDocumentsBridge, () => true)

  if (code === 5000) {await expect(action).rejects.toThrow('rpc failed'); expect(api.updateDeepChatOutcome).not.toHaveBeenCalled()}
  else {expect((await action).outcome?.status).toBe('unavailable')}
})
