import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $voiceLiveStatus } from '@/store/voice-live'

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  legacy: vi.fn(),
  start: vi.fn(async () => undefined),
  close: vi.fn(),
  think: vi.fn(),
  speak: vi.fn(),
  setMuted: vi.fn(),
  instruct: vi.fn()
}))

vi.mock('@/lib/qwen-realtime', () => ({
  QwenRealtimeSession: vi.fn(function () {
    mocks.native()

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

afterEach(() => {
  cleanup()
  $voiceLiveStatus.set(null)
  vi.clearAllMocks()
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
