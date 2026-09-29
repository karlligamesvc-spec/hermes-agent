import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { AnalysisChatLink } from '../../../../shared/analysis-chat-link'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import { refreshAnalysisTurnOutcome } from '../video-analysis-turn-outcome'

import { DeepAnalysisTurn } from './deep-analysis-turn'

vi.mock('../video-analysis-turn-outcome', () => ({ refreshAnalysisTurnOutcome: vi.fn() }))
const source = { id: 'source' } as AnalysisDocument
const link: AnalysisChatLink = { sessionId: 'durable', connectionId: 'local', profile: 'default', submittedAt: '2026-09-29T00:00:00Z', turn: { id: 'turn', runtimeSessionId: 'runtime' } }
const bridge = { updateDeepChatOutcome: vi.fn() } as unknown as AnalysisDocumentsBridge
const observed = (status: NonNullable<AnalysisChatLink['outcome']>['status']): AnalysisChatLink => ({ ...link, outcome: { status, observedAt: '2026-09-29T00:01:00Z' } })
afterEach(() => {cleanup(); vi.mocked(refreshAnalysisTurnOutcome).mockReset()})
it('refreshes an unfinished attempt, then reopens its saved terminal observation without claiming a verified report', async () => {
  vi.mocked(refreshAnalysisTurnOutcome).mockResolvedValueOnce(observed('running')).mockResolvedValueOnce(observed('complete'))
  const view = render(<DeepAnalysisTurn bridge={bridge} link={link} locale="en" source={source} />)
  await screen.findByText(/Running/)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh this submission status' }))
  await screen.findByText(/Execution ended; the report and its claims remain unverified/)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  view.unmount()
  render(<DeepAnalysisTurn bridge={bridge} link={observed('complete')} locale="en" source={source} />)
  expect(screen.getByText(/claims remain unverified/)).toBeTruthy()
  expect(refreshAnalysisTurnOutcome).toHaveBeenCalledTimes(2)
})
it('keeps transport failures retryable and missing turn identities explicitly unknown', async () => {
  vi.mocked(refreshAnalysisTurnOutcome).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(observed('unavailable'))
  const view = render(<DeepAnalysisTurn bridge={bridge} link={link} locale="en" source={source} />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh this submission status' }))
  await screen.findByText(/runtime no longer has this outcome/)
  expect(screen.queryByRole('alert')).toBeNull()
  view.unmount()
  render(<DeepAnalysisTurn bridge={bridge} link={{ ...link, turn: undefined }} locale="en" source={source} />)
  expect(screen.getByText(/Not confirmed; open the chat/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(refreshAnalysisTurnOutcome).toHaveBeenCalledTimes(2)
})
it('invalidates an in-flight read when the source view unmounts', async () => {
  let finish!: (value: AnalysisChatLink) => void
  vi.mocked(refreshAnalysisTurnOutcome).mockImplementation(() => new Promise(resolve => {finish = resolve}))
  const view = render(<DeepAnalysisTurn bridge={bridge} link={link} locale="en" source={source} />)
  await waitFor(() => expect(refreshAnalysisTurnOutcome).toHaveBeenCalledTimes(1))
  const isCurrent = vi.mocked(refreshAnalysisTurnOutcome).mock.calls[0][3]
  expect(isCurrent()).toBe(true)
  view.unmount()
  expect(isCurrent()).toBe(false)
  await act(async () => {finish(observed('complete'))})
})
