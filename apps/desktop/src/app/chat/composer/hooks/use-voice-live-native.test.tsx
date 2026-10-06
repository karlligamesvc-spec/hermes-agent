import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { VoiceLiveHandlers } from '@/lib/voice-live'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $voiceLiveStatus } from '@/store/voice-live'

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  handlers: null as VoiceLiveHandlers | null,
  legacy: vi.fn(),
  start: vi.fn(async () => undefined),
  close: vi.fn(),
  think: vi.fn(),
  speak: vi.fn(),
  setMuted: vi.fn(),
  instruct: vi.fn()
}))

vi.mock('@/lib/qwen-realtime', () => ({
  QwenRealtimeSession: vi.fn(function (handlers: VoiceLiveHandlers) {
    mocks.native()
    mocks.handlers = handlers

    return mocks
  })
}))
vi.mock('@/lib/voice-live', async importOriginal => ({
  ...(await importOriginal<object>()),
  VoiceLiveSession: vi.fn(function () {
    mocks.legacy()

    return mocks
  })
}))
const { useVoiceLiveConversation } = await import('./use-voice-live-conversation')

it('inserts late user ASR before its reply without splitting assistant deltas or reopening a call', async () => {
  const hook = renderHook(({ enabled }) => useVoiceLiveConversation({
    enabled, busy: false, onFatalError: vi.fn(), onSubmit: vi.fn(),
    pendingResponse: () => null, consumePendingResponse: vi.fn(), seedHistory: () => []
  }), {
    initialProps: { enabled: false },
    wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider>
  })

  act(() => hook.rerender({ enabled: true }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  act(() => {
    mocks.handlers?.onTranscript?.({ speaker: 'assistant', text: '你好', turnId: 'r1', turnOrder: 2, startMs: 10, endMs: 10 })
    mocks.handlers?.onTranscript?.({ speaker: 'user', text: 'Hello，Max。', turnId: 'u1', turnOrder: 1, startMs: 11, endMs: 11 })
    mocks.handlers?.onTranscript?.({ speaker: 'assistant', text: '呀！', turnId: 'r1', turnOrder: 2, startMs: 12, endMs: 12 })
  })
  expect(hook.result.current.transcript.map(fragment => fragment.text)).toEqual(['Hello，Max。', '你好', '呀！'])
  expect(mocks.native).toHaveBeenCalledOnce()
  expect(mocks.close).not.toHaveBeenCalled()
})

afterEach(() => {
  cleanup()
  $voiceLiveStatus.set(null)
  clearNotifications()
  vi.clearAllMocks()
})

it.each([true, false])('retains one actionable error when a call fails; fatal=%s', async fatal => {
  const onFatalError = vi.fn()

  const hook = renderHook(({ enabled }) => useVoiceLiveConversation({
    enabled,
    busy: false,
    onFatalError,
    onSubmit: vi.fn(),
    pendingResponse: () => null,
    consumePendingResponse: vi.fn(),
    seedHistory: () => []
  }), {
    initialProps: { enabled: false },
    wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider>
  })

  act(() => hook.rerender({ enabled: true }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  act(() => {
    if (fatal) {mocks.handlers?.onError('APEX quota exhausted. Please check your quota.', true)}
    mocks.handlers?.onClosed(fatal ? 'voice_error' : 'connection_closed', null)
  })
  expect($notifications.get()).toHaveLength(1)
  expect($notifications.get()[0].message).toBe(fatal ? 'APEX quota exhausted. Please check your quota.' : 'connection_closed')
  expect(onFatalError).toHaveBeenCalledOnce()
  expect(hook.result.current.status).toBe('idle')
  act(() => mocks.handlers?.onError('Late callback from the ended call', true))
  expect($notifications.get()).toHaveLength(1)
})

it('the actual Desktop call uses native Qwen with an existing GPT preference and releases it on unmount', async () => {
  $voiceLiveStatus.set({
    mode: 'gpt-live',
    available: true,
    qwenAvailable: true,
    reason: null,
    model: 'GPT',
    voice: 'marin'
  })

  const history = [
    {
      type: 'message' as const,
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text: 'Earlier task' }]
    }
  ]

  const hook = renderHook(
    ({ enabled }) =>
      useVoiceLiveConversation({
        enabled,
        busy: false,
        onSubmit: vi.fn(),
        pendingResponse: () => null,
        consumePendingResponse: vi.fn(),
        seedHistory: () => history
      }),
    {
      initialProps: { enabled: false },
      wrapper: ({ children }) => (
        <I18nProvider configClient={null} initialLocale="en">
          {children}
        </I18nProvider>
      )
    }
  )

  act(() => hook.rerender({ enabled: true }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(history))
  expect(mocks.native).toHaveBeenCalledTimes(1)
  expect(mocks.legacy).not.toHaveBeenCalled()
  hook.unmount()
  expect(mocks.close).toHaveBeenCalledTimes(1)
})
