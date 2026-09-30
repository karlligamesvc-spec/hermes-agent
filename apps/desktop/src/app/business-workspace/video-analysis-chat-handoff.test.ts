import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { setConnection } from '@/store/session'

import type { AnalysisDocumentsBridge } from './analysis-types'
import { analysisChatSubmitOptions } from './video-analysis-chat-handoff'

const originalDesktop = window.hermesDesktop
const draft = { sourceId: 'source', scope: 'owner', revision: 'revision', directory: '/tmp/output', locale: 'en', connectionId: 'local', profile: 'default' }
const prompt = 'Reviewed draft\n"/tmp/output"'
const record = vi.fn(async () => ({ ok: true }))
beforeEach(() => {
  setConnection({ connectionId: 'local', mode: 'local', baseUrl: 'http://127.0.0.1', wsUrl: 'ws://127.0.0.1', token: '', logs: [], isFullscreen: false, nativeOverlayWidth: 0, windowButtonPosition: null }); $activeGatewayProfile.set('default'); clearNotifications(); record.mockClear()
  window.hermesDesktop = { analysisDocuments: { recordDeepChat: record } as unknown as AnalysisDocumentsBridge } as typeof window.hermesDesktop
})
afterEach(() => {window.hermesDesktop = originalDesktop; setConnection(null); $activeGatewayProfile.set('default')})
it('waits for the accepted durable target and never associates preparation, rewritten drafts or changed profiles', async () => {
  const options = analysisChatSubmitOptions(draft, prompt)
  expect(record).not.toHaveBeenCalled()
  expect(options && options.onAccepted).toBeTypeOf('function')

  if (!options) {throw new Error('missing options')}
  await options.onAccepted!({ storedSessionId: 'stored-not-runtime' })
  expect(record).toHaveBeenCalledExactlyOnceWith('source', 'owner', 'revision', { sessionId: 'stored-not-runtime', connectionId: 'local', profile: 'default' })
  expect(analysisChatSubmitOptions(draft, 'Unrelated user replacement')).toBeUndefined()
  $activeGatewayProfile.set('other')
  expect(analysisChatSubmitOptions(draft, prompt)).toBe(false)
  await options.onAccepted!({ storedSessionId: 'must-not-record' })
  expect(record).toHaveBeenCalledTimes(1)
  expect($notifications.get().some(item => item.title?.includes('do not resend'))).toBe(true)
})
it('does not turn a failed receipt write into a failed or duplicate chat send', async () => {
  record.mockResolvedValueOnce({ ok: false })
  const options = analysisChatSubmitOptions(draft, prompt)

  if (!options) {throw new Error('missing options')}
  await expect(options.onAccepted!({ storedSessionId: 'already-sent' })).resolves.toBeUndefined()
  expect(record).toHaveBeenCalledTimes(1)
  expect($notifications.get().some(item => item.title?.includes('do not resend'))).toBe(true)
})

it('preserves the runtime-issued attempt separately from the durable chat target', async () => {
  const options = analysisChatSubmitOptions(draft, prompt)

  if (!options) {throw new Error('missing options')}
  const turn = { id: 'issued-turn', runtimeSessionId: 'runtime-after-resume' }
  await options.onAccepted!({ storedSessionId: 'durable', turn })
  expect(record).toHaveBeenCalledExactlyOnceWith('source', 'owner', 'revision', { sessionId: 'durable', connectionId: 'local', profile: 'default', turn })
})


it('carries the exact prepared workspace only on acceptance and refuses malformed IDs', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const options = analysisChatSubmitOptions({ ...draft, workspaceId }, prompt)

  if (!options) {throw new Error('missing options')}
  expect(record).not.toHaveBeenCalled()
  await options.onAccepted!({ storedSessionId: 'accepted' })
  expect(record).toHaveBeenCalledExactlyOnceWith('source', 'owner', 'revision', { sessionId: 'accepted', connectionId: 'local', profile: 'default', workspaceId })

  for (const invalid of ['../outside', '', null, 123]) {
    expect(analysisChatSubmitOptions({ ...draft, workspaceId: invalid }, prompt)).toBeUndefined()
  }
})
