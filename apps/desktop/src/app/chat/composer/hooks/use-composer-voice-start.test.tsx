import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { VoiceLiveStatus } from '@/lib/voice-live'
import { $voiceConversationStartRequest, takeVoiceConversationStart } from '@/store/composer'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  nativeEnabled: vi.fn(),
  chainedEnabled: vi.fn(),
  end: vi.fn(),
  syncTtsLease: vi.fn(async () => undefined),
  cancelDictation: vi.fn(async () => undefined),
  dictate: vi.fn(),
  beforeMicOpen: null as null | (() => Promise<void>)
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
  useVoiceRecorder: () => ({ cancel: mocks.cancelDictation, dictate: mocks.dictate, voiceActivityState: 'idle', voiceStatus: 'idle' })
}))
vi.mock('./use-voice-conversation', () => ({
  useVoiceConversation: ({ enabled }: { enabled: boolean }) => {
    mocks.chainedEnabled(enabled)

    return { end: mocks.end, status: 'idle', level: 0, muted: false }
  }
}))
vi.mock('./use-voice-live-conversation', () => ({
  useVoiceLiveConversation: ({ enabled, beforeMicOpen }: { enabled: boolean; beforeMicOpen: () => Promise<void> }) => {
    mocks.nativeEnabled(enabled)
    mocks.beforeMicOpen = beforeMicOpen

    return { end: mocks.end, status: 'idle', level: 0, muted: false, transcript: [] }
  }
}))
const { useComposerVoice } = await import('./use-composer-voice')
afterEach(() => {
  cleanup()
  takeVoiceConversationStart($voiceConversationStartRequest.get())
  vi.clearAllMocks()
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
      await act(async () => {await mocks.beforeMicOpen?.()})
      expect(mocks.cancelDictation).toHaveBeenCalledOnce()
      act(() => hook.result.current.dictate())
      expect(mocks.dictate).not.toHaveBeenCalled()
    }
  }
)
