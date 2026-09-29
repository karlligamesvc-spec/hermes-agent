import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { openSession } from '@/app/open-session'
import { getSession } from '@/hermes'
import { $activeGatewayProfile } from '@/store/profile'
import { setConnection } from '@/store/session'

import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'

import { DeepAnalysisChat } from './deep-analysis-chat'

vi.mock('@/app/open-session', () => ({ openSession: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), getSession: vi.fn() }))
const source: AnalysisDocument = { id: 'source', analysis_scope: 'owner', analysis_revision: 'rev', filename: 'source.srt', kind: 'subtitle', status: 'ready', storageMode: 'local' }
const link = { sessionId: 'stored-id', connectionId: 'local', profile: 'worker', submittedAt: new Date().toISOString() }
beforeEach(() => {setConnection({ connectionId: 'local', mode: 'local', baseUrl: 'http://127.0.0.1', wsUrl: 'ws://127.0.0.1', token: '', logs: [], isFullscreen: false, nativeOverlayWidth: 0, windowButtonPosition: null }); $activeGatewayProfile.set('worker'); vi.mocked(getSession).mockReset(); vi.mocked(openSession).mockReset()})
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
  await waitFor(() => expect(openSession).toHaveBeenCalledExactlyOnceWith('stored-id', expect.any(Function)))
  expect(getSession).toHaveBeenLastCalledWith('stored-id', { connectionId: 'local', profile: 'worker' })
  expect(readDeepChat).toHaveBeenCalledWith('source', 'owner', 'rev')
})
it.each(['unmounted', 'profile', 'account'] as const)('does not navigate after a late session check outlives %s', async mode => {
  const readDeepChat = vi.fn(async () => ({ ok: true, item: link }))
  const view = render(<MemoryRouter><DeepAnalysisChat bridge={{ readDeepChat } as unknown as AnalysisDocumentsBridge} locale="en" source={source} /></MemoryRouter>)
  let complete!: (value: Awaited<ReturnType<typeof getSession>>) => void
  vi.mocked(getSession).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open latest submitted breakdown chat' }))
  await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1))

  if (mode === 'unmounted') {view.unmount()}

  if (mode === 'profile') {$activeGatewayProfile.set('other')}

  if (mode === 'account') {readDeepChat.mockResolvedValue({ ok: false, item: link })}
  await act(async () => {complete({ id: link.sessionId } as Awaited<ReturnType<typeof getSession>>)})
  expect(openSession).not.toHaveBeenCalled()
})
