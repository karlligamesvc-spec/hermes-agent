import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'

import { SOURCE_ANSWER_COPY, SourceQuestionAction } from './source-question-answer'

const source: AnalysisDocument = { id: 'local-a', analysis_scope: 'owner', analysis_revision: 'a'.repeat(64),
  filename: 'facts.txt', kind: 'text', status: 'ready', storageMode: 'local',
  anchors: [{ id: 'a1', text: 'Revenue grew.', location: { paragraph: 1 } }] }

const initial = { auth: $authState.get(), profile: $activeGatewayProfile.get() }
afterEach(() => {
  cleanup(); $gateway.set(null); $connection.set(null); $authState.set(initial.auth)
  $activeGatewayProfile.set(initial.profile)
})

function fixture() {
  const bridge = { questionContext: vi.fn().mockResolvedValue({ ok: true, item: source }),
    saveAnswer: vi.fn().mockResolvedValue({ ok: true, item: { id: 'q1' } }) } as unknown as AnalysisDocumentsBridge

  let finish!: (value: { text: string }) => void
  const request = vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve }))
  $gateway.set({ request } as never)
  const onSaved = vi.fn().mockResolvedValue(undefined)

  return { bridge, request, onSaved, finish: () => finish({ text: JSON.stringify({ answer_type: 'semantic_answer', answer: 'Revenue grew.', anchor_ids: ['a1'] }) }) }
}

it('requires an explicit click, prevents duplicate spending and reports saved results', async () => {
  const f = fixture()
  render(<SourceQuestionAction bridge={f.bridge} locale="en" onSaved={f.onSaved} question="Revenue?" source={source} />)
  expect(f.request).not.toHaveBeenCalled()
  expect(screen.getByText(SOURCE_ANSWER_COPY.en.disclosure)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Ask the Agent' }))
  fireEvent.click(screen.getByRole('button', { name: 'Answering from the source…' }))
  await waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
  await act(async () => f.finish())
  expect(f.bridge.saveAnswer).toHaveBeenCalledTimes(1)
  expect(f.onSaved).toHaveBeenCalledWith(source.id)
})

it.each(['profile', 'account', 'connection', 'gateway', 'source', 'unmount'])('discards an answer after %s changes', async change => {
  const f = fixture()
  const view = render(<SourceQuestionAction bridge={f.bridge} locale="en" onSaved={f.onSaved} question="Revenue?" source={source} />)
  fireEvent.click(screen.getByRole('button', { name: 'Ask the Agent' }))
  await waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
  act(() => {
    if (change === 'profile') {$activeGatewayProfile.set('other')}

    if (change === 'account') {$authState.set({ ...initial.auth, account: { ...initial.auth.account, email: 'other@example.test' } })}

    if (change === 'connection') {$connection.set({ mode: 'local', connectionId: 'other', baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1', token: '', logs: [], isFullscreen: false, nativeOverlayWidth: 0, windowButtonPosition: null })}

    if (change === 'gateway') {$gateway.set(null)}

    if (change === 'source') {view.rerender(<SourceQuestionAction bridge={f.bridge} locale="en" onSaved={f.onSaved} question="Revenue?" source={{ ...source, id: 'local-b' }} />)}

    if (change === 'unmount') {view.unmount()}
  })
  await act(async () => f.finish())
  expect(f.bridge.saveAnswer).not.toHaveBeenCalled()
  expect(f.onSaved).not.toHaveBeenCalled()
})

it('shows a safe failure and allows retry without exposing provider errors', async () => {
  const f = fixture()
  f.request.mockRejectedValueOnce(new Error('provider secret'))
  render(<SourceQuestionAction bridge={f.bridge} locale="zh" onSaved={f.onSaved} question="营收如何？" source={source} />)
  fireEvent.click(screen.getByRole('button', { name: SOURCE_ANSWER_COPY.zh.ask }))
  expect(await screen.findByText(SOURCE_ANSWER_COPY.zh.failed)).toBeTruthy()
  expect(screen.queryByText('provider secret')).toBeNull()
  expect(screen.getByRole('button', { name: SOURCE_ANSWER_COPY.zh.ask }).hasAttribute('disabled')).toBe(false)
  expect(f.bridge.saveAnswer).not.toHaveBeenCalled()
})

it.each(['zh', 'zh-hant', 'en', 'ja', 'ar'] as const)('discloses model use and keeps the %s action disabled offline', locale => {
  render(<SourceQuestionAction bridge={null} locale={locale} onSaved={vi.fn()} question="Revenue?" source={source} />)
  expect(screen.getByText(SOURCE_ANSWER_COPY[locale].disclosure)).toBeTruthy()
  expect(screen.getByRole('button', { name: SOURCE_ANSWER_COPY[locale].ask }).hasAttribute('disabled')).toBe(true)
})
