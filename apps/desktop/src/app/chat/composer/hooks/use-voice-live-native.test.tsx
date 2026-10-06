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
  finishDelegation: vi.fn(),
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

it.each(['asr', 'delegation'] as const)('closes a Chinese voice-end command once through %s without submitting a chat turn', async entry => {
  const onSubmit = vi.fn()
  const onStopWord = vi.fn()

  const hook = renderHook(({ enabled }) => useVoiceLiveConversation({
    enabled, busy: false, onSubmit, onStopWord, pendingResponse: () => null,
    consumePendingResponse: vi.fn(), seedHistory: () => []
  }), {
    initialProps: { enabled: false },
    wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider>
  })

  act(() => hook.rerender({ enabled: true }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  const stop = { speaker: 'user' as const, text: 'OK，你关闭吧。', turnId: 'stop-turn', startMs: 2, endMs: 2 }
  act(() => {
    // A late completed query ASR must not concatenate with a separate stop turn.
    mocks.handlers?.onTranscript?.({ speaker: 'user', text: '查询抖音热榜', turnId: 'query', startMs: 1, endMs: 1 })

    if (entry === 'asr') {mocks.handlers?.onTranscript?.(stop)}
    else {mocks.handlers?.onDelegation('close-request', [stop])}
  })
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(onStopWord).toHaveBeenCalledOnce()
  expect(onSubmit).not.toHaveBeenCalled()
  expect(hook.result.current.status).toBe('idle')
  act(() => {
    mocks.handlers?.onTranscript?.(stop)
    mocks.handlers?.onDelegation('late-close', [stop])
  })
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(onStopWord).toHaveBeenCalledOnce()
  expect(onSubmit).not.toHaveBeenCalled()
})

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
  vi.useRealTimers()
  $voiceLiveStatus.set(null)
  clearNotifications()
  vi.clearAllMocks()
})

it('keeps a slow new-chat delegation pending through idle gaps and returns the actual hot-list result once', async () => {
  let accept: ((accepted: boolean) => void) | undefined
  let response: { id: string; pending: boolean; text: string } | null = null
  const onSubmit = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve }))
  const consume = vi.fn()

  const hook = renderHook(({ enabled, busy }) => useVoiceLiveConversation({
    enabled, busy, onSubmit, pendingResponse: () => response,
    consumePendingResponse: consume, seedHistory: () => []
  }), {
    initialProps: { enabled: false, busy: false },
    wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider>
  })

  act(() => hook.rerender({ enabled: true, busy: false }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  vi.useFakeTimers()
  await act(async () => {
    mocks.handlers?.onDelegation('douyin', [{ speaker: 'user', text: '查询抖音热榜', startMs: 0, endMs: 0 }])
  })
  expect(onSubmit).toHaveBeenCalledWith('查询抖音热榜', 'User: 查询抖音热榜')
  act(() => vi.advanceTimersByTime(20_000))
  expect(mocks.finishDelegation).not.toHaveBeenCalled()
  await act(async () => { accept?.(true) })
  act(() => hook.rerender({ enabled: true, busy: true }))
  act(() => vi.advanceTimersByTime(200))
  act(() => hook.rerender({ enabled: true, busy: false }))
  act(() => vi.advanceTimersByTime(20_000))
  expect(mocks.finishDelegation).not.toHaveBeenCalled()
  expect(hook.result.current.status).toBe('thinking')
  act(() => {
    response = { id: 'answer', pending: false, text: '抖音当前热榜拿到19条，这是本次返回的样本。' }
    vi.advanceTimersByTime(200)
  })
  expect(mocks.speak).toHaveBeenCalledExactlyOnceWith('douyin', '抖音当前热榜拿到19条，这是本次返回的样本。')
  expect(mocks.finishDelegation).toHaveBeenCalledExactlyOnceWith('douyin')
  expect(consume).toHaveBeenCalledTimes(2)
  act(() => vi.advanceTimersByTime(20_000))
  expect(mocks.finishDelegation).toHaveBeenCalledOnce()
})

it('does not let a superseded submit failure finish the newer voice task', async () => {
  let rejectOld: ((error: Error) => void) | undefined

  const onSubmit = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
    .mockResolvedValue(true)

  const hook = renderHook(({ enabled }) => useVoiceLiveConversation({
    enabled, busy: false, onSubmit, pendingResponse: () => null,
    consumePendingResponse: vi.fn(), seedHistory: () => []
  }), {
    initialProps: { enabled: false },
    wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider>
  })

  act(() => hook.rerender({ enabled: true }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  await act(async () => { mocks.handlers?.onDelegation('old', [{ speaker: 'user', text: '旧请求', startMs: 0, endMs: 0 }]) })
  await act(async () => { mocks.handlers?.onDelegation('new', [{ speaker: 'user', text: '新请求', startMs: 1, endMs: 1 }]) })
  await act(async () => { rejectOld?.(new Error('Late failure')) })
  expect(mocks.speak).not.toHaveBeenCalled()
  expect(mocks.finishDelegation).not.toHaveBeenCalled()
  expect($notifications.get()).toHaveLength(0)
  expect(hook.result.current.status).toBe('thinking')
})

it('finishes an explicitly rejected submit with an honest error instead of waiting for a nonexistent answer', async () => {
  const hook = renderHook(({ enabled }) => useVoiceLiveConversation({
    enabled, busy: false, onSubmit: async () => false, pendingResponse: () => null,
    consumePendingResponse: vi.fn(), seedHistory: () => []
  }), {
    initialProps: { enabled: false },
    wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider>
  })

  act(() => hook.rerender({ enabled: true }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  await act(async () => { mocks.handlers?.onDelegation('rejected', [{ speaker: 'user', text: '查询', startMs: 0, endMs: 0 }]) })
  expect(mocks.speak).toHaveBeenCalledExactlyOnceWith('rejected', 'Sorry, I could not reach Hermes for that request.')
  expect(mocks.finishDelegation).toHaveBeenCalledExactlyOnceWith('rejected')
  expect(hook.result.current.status).toBe('listening')
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
