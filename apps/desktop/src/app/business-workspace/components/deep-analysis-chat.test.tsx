import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { openSession } from '@/app/open-session'
import { getSession } from '@/hermes'
import { $activeGatewayProfile } from '@/store/profile'
import { setConnection, setSessionOwnerHint } from '@/store/session'

import type { AnalysisChatLink } from '../../../../shared/analysis-chat-link'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'

import { DeepAnalysisChat } from './deep-analysis-chat'

vi.mock('@/store/session', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), setSessionOwnerHint: vi.fn() }))
vi.mock('@/app/open-session', () => ({ openSession: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), getSession: vi.fn() }))
const source: AnalysisDocument = { id: 'source', analysis_scope: 'owner', analysis_revision: 'rev', filename: 'source.srt', kind: 'subtitle', status: 'ready', storageMode: 'local' }
const link: AnalysisChatLink = { sessionId: 'stored-id', connectionId: 'local', profile: 'worker', submittedAt: new Date().toISOString() }
beforeEach(() => {setConnection({ connectionId: 'local', mode: 'local', baseUrl: 'http://127.0.0.1', wsUrl: 'ws://127.0.0.1', token: '', logs: [], isFullscreen: false, nativeOverlayWidth: 0, windowButtonPosition: null }); $activeGatewayProfile.set('worker'); vi.mocked(getSession).mockReset(); vi.mocked(openSession).mockReset(); vi.mocked(setSessionOwnerHint).mockReset()})
afterEach(() => {cleanup(); setConnection(null); $activeGatewayProfile.set('default')})
it('opens the accepted durable conversation on its original connection/profile and keeps missing sessions retryable', async () => {
  const readDeepChat = vi.fn(async () => ({ ok: true, item: link }))
  render(<MemoryRouter><DeepAnalysisChat bridge={{ readDeepChat } as unknown as AnalysisDocumentsBridge} locale="en" source={source} /></MemoryRouter>)
  const button = await screen.findByRole('button', { name: 'Open latest submitted breakdown chat' })
  vi.mocked(getSession).mockRejectedValueOnce(new Error('404'))
  fireEvent.click(button)
  await screen.findByRole('alert')
  expect(openSession).not.toHaveBeenCalled()
  vi.mocked(getSession).mockResolvedValueOnce({ id: link.sessionId } as Awaited<ReturnType<typeof getSession>>)
  fireEvent.click(button)
  await waitFor(() => expect(openSession).toHaveBeenCalledExactlyOnceWith('stored-id', expect.any(Function), 'in-place', { workspaceMode: 'sessions', ownerRoute: { connectionId: 'local', profile: 'worker', mode: 'local' } }))
  expect(setSessionOwnerHint).toHaveBeenCalledExactlyOnceWith('stored-id', { connectionId: 'local', profile: 'worker', mode: 'local' })
  expect(getSession).toHaveBeenLastCalledWith('stored-id', { connectionId: 'local', profile: 'worker' })
  expect(readDeepChat).toHaveBeenCalledWith('source', 'owner', 'rev')
})
it.each(['unmounted', 'profile', 'account', 'link_profile', 'link_connection', 'link_time', 'link_workspace'] as const)('does not navigate after a late session check outlives %s', async mode => {
  const readDeepChat = vi.fn(async () => ({ ok: true, item: link }))
  const view = render(<MemoryRouter><DeepAnalysisChat bridge={{ readDeepChat } as unknown as AnalysisDocumentsBridge} locale="en" source={source} /></MemoryRouter>)
  let complete!: (value: Awaited<ReturnType<typeof getSession>>) => void
  vi.mocked(getSession).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open latest submitted breakdown chat' }))
  await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1))

  if (mode === 'unmounted') {view.unmount()}

  if (mode === 'profile') {$activeGatewayProfile.set('other')}

  if (mode === 'account') {readDeepChat.mockResolvedValue({ ok: false, item: link })}

  if (mode === 'link_profile') {readDeepChat.mockResolvedValue({ ok: true, item: { ...link, profile: 'another' } })}

  if (mode === 'link_connection') {readDeepChat.mockResolvedValue({ ok: true, item: { ...link, connectionId: 'another' } })}

  if (mode === 'link_workspace') {readDeepChat.mockResolvedValue({ ok: true, item: { ...link, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })}

  if (mode === 'link_time') {readDeepChat.mockResolvedValue({ ok: true, item: { ...link, submittedAt: '2025-01-01T00:00:00.000Z' } })}
  await act(async () => {complete({ id: link.sessionId } as Awaited<ReturnType<typeof getSession>>)})
  expect(openSession).not.toHaveBeenCalled()
  expect(setSessionOwnerHint).not.toHaveBeenCalled()
})
