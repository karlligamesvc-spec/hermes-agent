import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'

import { VideoSourceConversation } from './video-source-conversation'

const original = { auth: $authState.get(), profile: $activeGatewayProfile.get() }
const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }))
afterEach(() => {
  cleanup()
  $gateway.set(null)
  $connection.set(null)
  $authState.set(original.auth)
  $activeGatewayProfile.set(original.profile)

  if (scroll) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

it('uses the picked model once, disables changes during an answer and clears it for another owner', async () => {
  const source: AnalysisDocument = {
    id: 'local-a',
    analysis_scope: 'owner',
    analysis_revision: 'a'.repeat(64),
    filename: 'video.srt',
    kind: 'subtitle',
    status: 'ready',
    storageMode: 'local',
    anchors: [{ id: 'a1', text: 'Revenue grew.', location: { start_seconds: 0, end_seconds: 1 } }]
  }

  const bridge = {
    questionContext: vi.fn().mockResolvedValue({ ok: true, item: source }),
    saveAnswer: vi.fn().mockResolvedValue({ ok: true, item: { id: 'q1' } })
  } as unknown as AnalysisDocumentsBridge

  let finish!: (value: { text: string }) => void

  const request = vi.fn((method: string) =>
    method === 'model.options'
      ? Promise.resolve({ providers: [{ slug: 'custom:test', name: 'My models', models: ['answer-a', 'answer-b'] }] })
      : new Promise<{ text: string }>(resolve => {
          finish = resolve
        })
  )

  $gateway.set({ request } as never)
  const onSaved = vi.fn().mockResolvedValue(undefined)
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VideoSourceConversation
        advanced={null}
        bridge={bridge}
        jump={vi.fn()}
        label={() => '0:00'}
        locale="en"
        onSaved={onSaved}
        question="What changed?"
        setQuestion={vi.fn()}
        source={source}
      />
    </QueryClientProvider>
  )
  const picker = screen.getByRole('combobox', { name: 'Choose answer model' })
  fireEvent.keyDown(picker, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'Answer B' }))
  expect(picker.textContent).toContain('Answer B')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      'llm.oneshot',
      expect.objectContaining({
        provider: 'custom:test',
        model: 'answer-b',
        profile: original.profile
      }),
      90000
    )
  )
  expect(picker.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(request.mock.calls.filter(([method]) => method === 'llm.oneshot')).toHaveLength(1)
  await act(async () =>
    finish({ text: JSON.stringify({ answer_type: 'semantic_answer', answer: 'Revenue grew.', anchor_ids: ['a1'] }) })
  )
  expect(onSaved).toHaveBeenCalledWith('local-a')
  act(() => $authState.set({ ...original.auth, account: { ...original.auth.account, email: 'other@example.test' } }))
  expect(screen.getByRole('combobox').textContent).toContain('Default (Agent settings)')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'llm.oneshot')).toHaveLength(2))

  const [, params] = (request.mock.calls as unknown as Array<[string, Record<string, unknown>]>).filter(
    ([method]) => method === 'llm.oneshot'
  )[1]

  expect(params).not.toHaveProperty('model')
  expect(params).not.toHaveProperty('provider')
})
