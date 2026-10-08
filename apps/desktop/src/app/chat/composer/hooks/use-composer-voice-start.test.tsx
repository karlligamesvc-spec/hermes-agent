import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type { SubmitTextOptions } from '@/app/session/hooks/use-prompt-actions/utils'
import type { ClientSessionState } from '@/app/types'
import { I18nProvider } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { markAssistantIdSpoken } from '@/lib/spoken-reply'
import type { VoiceLiveStatus } from '@/lib/voice-live'
import { $voiceConversationStartRequest, takeVoiceConversationStart } from '@/store/composer'
import { $messages } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { $voiceSessionOwners } from '@/store/voice-session-owner'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  nativeEnabled: vi.fn(),
  chainedEnabled: vi.fn(),
  end: vi.fn(),
  syncTtsLease: vi.fn(async () => undefined),
  cancelDictation: vi.fn(async () => undefined),
  dictate: vi.fn(),
  beforeMicOpen: null as null | (() => Promise<void>),
  submitDelegation: null as null | ((text: string, context: string) => Promise<boolean>),
  pendingLiveReply: null as null | (() => { id: string; pending: boolean; text: string } | null)
}))

vi.mock('@/store/voice-live', () => ({
  refreshVoiceLiveStatus: mocks.refresh,
  selectedVoiceChatMode: (status: VoiceLiveStatus | null) => status?.mode ?? 'chained'
}))
vi.mock('@/lib/tts-lease', () => ({
  CONVERSATION_LEASE: 'conversation',
  READ_ALOUD_LEASE: 'read',
  syncTtsLease: mocks.syncTtsLease
}))
vi.mock('@/store/wake-word', () => ({ resumeWakeAfterVoice: vi.fn() }))
vi.mock('./use-auto-speak-replies', () => ({ useAutoSpeakReplies: () => undefined }))
vi.mock('./use-voice-recorder', () => ({
  useVoiceRecorder: () => ({
    cancel: mocks.cancelDictation,
    dictate: mocks.dictate,
    voiceActivityState: 'idle',
    voiceStatus: 'idle'
  })
}))
vi.mock('./use-voice-conversation', () => ({
  useVoiceConversation: ({ enabled }: { enabled: boolean }) => {
    mocks.chainedEnabled(enabled)

    return { end: mocks.end, status: 'idle', level: 0, muted: false }
  }
}))
vi.mock('./use-voice-live-conversation', () => ({
  useVoiceLiveConversation: ({
    enabled,
    beforeMicOpen,
    onSubmit,
    pendingResponse
  }: {
    enabled: boolean
    beforeMicOpen: () => Promise<void>
    onSubmit: (text: string, context: string) => Promise<boolean>
    pendingResponse: () => { id: string; pending: boolean; text: string } | null
  }) => {
    mocks.nativeEnabled(enabled)
    mocks.beforeMicOpen = beforeMicOpen
    mocks.submitDelegation = onSubmit
    mocks.pendingLiveReply = pendingResponse

    return { end: mocks.end, status: 'idle', level: 0, muted: false, transcript: [] }
  }
}))
const { useComposerVoice } = await import('./use-composer-voice')
afterEach(() => {
  cleanup()
  $messages.set([])
  $sessionStates.set({})
  expect($voiceSessionOwners.get().size).toBe(0)
  takeVoiceConversationStart($voiceConversationStartRequest.get())
  vi.clearAllMocks()
})

it('selects only the new delegated turn after an interrupted older turn appends text', () => {
  mocks.refresh.mockResolvedValue(null)

  const messages: ChatMessage[] = [
    { id: 'old-user', role: 'user', parts: [{ type: 'text', text: '旧请求' }] },
    { id: 'old-start', role: 'assistant', parts: [{ type: 'text', text: '旧请求开始' }] },
    { id: 'old-tail', role: 'assistant', parts: [{ type: 'text', text: '旧请求未完成' }] },
    { id: 'new-user', role: 'user', parts: [{ type: 'text', text: '查询抖音热榜' }] },
    { id: 'new-answer', role: 'assistant', parts: [{ type: 'text', text: '热榜返回19条样本。' }] }
  ]

  $messages.set(messages)
  markAssistantIdSpoken('live-result-owner', messages, 'old-start')
  renderHook(
    () =>
      useComposerVoice({
        busy: false,
        clearDraft: vi.fn(),
        disabled: false,
        focusInput: vi.fn(),
        insertText: vi.fn(),
        maxRecordingSeconds: 30,
        onSubmit: async () => true,
        onTranscribeAudio: undefined,
        sessionId: 'live-result-owner',
        target: 'main'
      }),
    {
      wrapper: ({ children }) => (
        <I18nProvider configClient={null} initialLocale="en">
          {children}
        </I18nProvider>
      )
    }
  )
  expect(mocks.pendingLiveReply?.()).toEqual({ id: 'new-answer', pending: false, text: '热榜返回19条样本。' })
})

it('forwards the real prompt.submit rejection to the live delegation owner', async () => {
  mocks.refresh.mockResolvedValue(null)
  const onSubmit = vi.fn(async () => false)
  renderHook(
    () =>
      useComposerVoice({
        busy: false,
        clearDraft: vi.fn(),
        disabled: false,
        focusInput: vi.fn(),
        insertText: vi.fn(),
        maxRecordingSeconds: 30,
        onSubmit,
        onTranscribeAudio: undefined,
        sessionId: null,
        target: 'main'
      }),
    {
      wrapper: ({ children }) => (
        <I18nProvider configClient={null} initialLocale="en">
          {children}
        </I18nProvider>
      )
    }
  )
  await expect(mocks.submitDelegation?.('查询抖音热榜', 'User: 查询抖音热榜')).resolves.toBe(false)
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith('查询抖音热榜', {
    surface: 'voice-live',
    voiceContext: 'User: 查询抖音热榜',
    onAccepted: expect.any(Function)
  })
})

it.each(['你查到哪一步了？', '你好呀', '继续查刚才那个', '请停止当前任务'])(
  'delivers a mid-task utterance to the same primary turn without pressing Stop: %s',
  async text => {
    mocks.refresh.mockResolvedValue(null)
    const onSubmit = vi.fn(async () => true)
    const onSteer = vi.fn(async () => true)
    const onInterrupt = vi.fn()
    renderHook(
      () =>
        useComposerVoice({
          busy: true,
          clearDraft: vi.fn(),
          disabled: false,
          focusInput: vi.fn(),
          insertText: vi.fn(),
          maxRecordingSeconds: 30,
          onSubmit,
          onSteer,
          onInterrupt,
          onTranscribeAudio: undefined,
          sessionId: 'existing-primary-task',
          target: 'main'
        }),
      {
        wrapper: ({ children }) => (
          <I18nProvider configClient={null} initialLocale="en">
            {children}
          </I18nProvider>
        )
      }
    )
    await expect(mocks.submitDelegation?.(text, `User: ${text}`)).resolves.toBe(true)
    expect(onSteer).toHaveBeenCalledExactlyOnceWith(text, undefined)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onInterrupt).not.toHaveBeenCalled()
  }
)

it('submits normally when the primary turn finishes before the interjection reaches it', async () => {
  mocks.refresh.mockResolvedValue(null)
  const onSubmit = vi.fn(async () => true)
  const onSteer = vi.fn(async () => false)
  renderHook(
    () =>
      useComposerVoice({
        busy: true,
        clearDraft: vi.fn(),
        disabled: false,
        focusInput: vi.fn(),
        insertText: vi.fn(),
        maxRecordingSeconds: 30,
        onSubmit,
        onSteer,
        onTranscribeAudio: undefined,
        sessionId: 'primary-settle-race',
        target: 'main'
      }),
    {
      wrapper: ({ children }) => (
        <I18nProvider configClient={null} initialLocale="en">
          {children}
        </I18nProvider>
      )
    }
  )
  await expect(mocks.submitDelegation?.('那结果呢？', 'User: 那结果呢？')).resolves.toBe(true)
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith('那结果呢？', {
    surface: 'voice-live',
    voiceContext: 'User: 那结果呢？',
    onAccepted: expect.any(Function)
  })
})

it.each(['resolved', 'cancelled', 'scope-changed', 'qwen-unavailable'] as const)(
  'voice waits for native admission before opening a microphone: %s',
  async outcome => {
    let resolve!: (status: VoiceLiveStatus | null) => void

    const pending = new Promise<VoiceLiveStatus | null>(done => {
      resolve = done
    })

    mocks.refresh.mockReturnValue(pending)

    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nProvider configClient={null} initialLocale="en">
        {children}
      </I18nProvider>
    )

    const hook = renderHook(
      () =>
        useComposerVoice({
          busy: false,
          clearDraft: vi.fn(),
          disabled: false,
          focusInput: vi.fn(),
          insertText: vi.fn(),
          maxRecordingSeconds: 30,
          onSubmit: vi.fn(async () => true),
          onTranscribeAudio: undefined,
          sessionId: null,
          target: 'main'
        }),
      { wrapper }
    )

    act(() => hook.result.current.startConversation())
    expect(hook.result.current.voiceConversationActive).toBe(true)
    expect(mocks.nativeEnabled.mock.calls.every(([enabled]) => enabled === false)).toBe(true)

    if (outcome === 'cancelled') {
      act(() => hook.result.current.endConversation())
    }

    await act(async () => {
      // Existing CLI/GPT preference does not require a user-facing engine switch.
      resolve(
        outcome === 'scope-changed'
          ? null
          : {
              mode: 'gpt-live',
              available: true,
              qwenAvailable: outcome !== 'qwen-unavailable',
              model: 'GPT',
              voice: 'longanqian',
              reason: null
            }
      )
      await pending
    })
    expect(hook.result.current.voiceConversationActive).toBe(outcome === 'resolved')
    expect(mocks.nativeEnabled.mock.calls.some(([enabled]) => enabled === true)).toBe(outcome === 'resolved')
    expect(mocks.chainedEnabled.mock.calls.every(([enabled]) => enabled === false)).toBe(true)

    if (outcome === 'resolved') {
      await act(async () => {
        await mocks.beforeMicOpen?.()
      })
      expect(mocks.cancelDictation).toHaveBeenCalledOnce()
      act(() => hook.result.current.dictate())
      expect(mocks.dictate).not.toHaveBeenCalled()
    }
  }
)

it.each(['history', 'home'] as const)(
  'a call started on %s retains its accepted conversation across navigation',
  async entry => {
    mocks.refresh.mockResolvedValue({ mode: 'qwen-realtime', available: true, qwenAvailable: true })
    const answer: ChatMessage = { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: '原会话回复' }] }

    const state = (storedSessionId: string, busy = false) =>
      ({ storedSessionId, busy, messages: [answer] }) as ClientSessionState

    if (entry === 'history') {
      $sessionStates.set({ 'owner-runtime': state('owner-stored') })
    }

    const onSubmit = vi.fn(async (_text: string, options?: SubmitTextOptions) => {
      $sessionStates.set({ ...$sessionStates.get(), 'owner-runtime': state('owner-stored') })
      await options?.onAccepted?.({
        storedSessionId: 'owner-stored',
        turn: { id: 'turn-1', runtimeSessionId: 'owner-runtime' }
      })

      return true
    })

    const onSteer = vi.fn(async () => true)
    const clearDraft = vi.fn()

    const hook = renderHook(
      ({ sessionId, busy }: { sessionId: string | null; busy: boolean }) =>
        useComposerVoice({
          busy,
          clearDraft,
          disabled: false,
          focusInput: vi.fn(),
          insertText: vi.fn(),
          maxRecordingSeconds: 30,
          onSubmit,
          onSteer,
          onTranscribeAudio: undefined,
          sessionId,
          target: 'main'
        }),
      {
        initialProps: { sessionId: entry === 'history' ? 'owner-runtime' : null, busy: false },
        wrapper: ({ children }) => (
          <I18nProvider configClient={null} initialLocale="en">
            {children}
          </I18nProvider>
        )
      }
    )

    await act(async () => {
      hook.result.current.startConversation()
    })
    await act(async () => {
      await mocks.submitDelegation?.('你好', 'User: 你好')
    })
    hook.rerender({ sessionId: 'owner-runtime', busy: false })
    await act(async () => {
      await mocks.submitDelegation?.('你能做什么', 'User: 你能做什么')
    })
    clearDraft.mockClear()
    hook.rerender({ sessionId: null, busy: false })
    $messages.set([{ id: 'unrelated', role: 'assistant', parts: [{ type: 'text', text: '别的会话' }] }])
    await act(async () => {
      await mocks.submitDelegation?.('继续', 'User: 继续')
    })
    expect(onSubmit.mock.lastCall?.[1]).toMatchObject({
      sessionId: 'owner-runtime',
      storedSessionId: 'owner-stored',
      attachments: []
    })
    expect(clearDraft).not.toHaveBeenCalled()
    expect(mocks.pendingLiveReply?.()?.text).toBe('原会话回复')
    hook.rerender({ sessionId: 'other-runtime', busy: true })
    await act(async () => {
      await mocks.submitDelegation?.('继续刚才的', 'User: 继续刚才的')
    })
    expect(onSteer).not.toHaveBeenCalled()
    expect(onSubmit.mock.lastCall?.[1]).toMatchObject({ sessionId: 'owner-runtime', storedSessionId: 'owner-stored' })
    act(() => {
      $sessionStates.set({ 'owner-runtime': state('owner-stored', true) })
    })
    hook.rerender({ sessionId: 'other-runtime', busy: false })
    await act(async () => {
      await mocks.submitDelegation?.('结果呢', 'User: 结果呢')
    })
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('结果呢', {
      sessionId: 'owner-runtime',
      storedSessionId: 'owner-stored'
    })
    act(() => {
      hook.result.current.endConversation()
    })
    act(() => {
      $sessionStates.set({ 'other-runtime': state('other-stored') })
    })
    await act(async () => {
      hook.result.current.startConversation()
    })
    await act(async () => {
      await mocks.submitDelegation?.('新通话', 'User: 新通话')
    })
    expect(onSubmit.mock.lastCall?.[1]).toMatchObject({ sessionId: 'other-runtime', storedSessionId: 'other-stored' })
  }
)
