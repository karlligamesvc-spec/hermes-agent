import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $notifications, clearNotifications } from '@/store/notifications'

const mocks = vi.hoisted(() => ({
  recording: false,
  start: vi.fn(async () => { mocks.recording = true }),
  stop: vi.fn(async () => {
    mocks.recording = false

    return { audio: new Blob(['test']) }
  }),
  cancel: vi.fn(() => { mocks.recording = false })
}))

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: mocks, recording: mocks.recording, level: 0 })
}))
const { useVoiceRecorder } = await import('./use-voice-recorder')

function setup(onTranscribeAudio = vi.fn(async () => 'Transcript')) {
  const onTranscript = vi.fn()
  const focusInput = vi.fn()

  const hook = renderHook(() => useVoiceRecorder({
    onTranscribeAudio, onTranscript, focusInput, maxRecordingSeconds: 30
  }), { wrapper: ({ children }) => <I18nProvider configClient={null} initialLocale="en">{children}</I18nProvider> })

  return { hook, onTranscript, focusInput }
}

afterEach(() => { cleanup(); clearNotifications(); vi.clearAllMocks(); mocks.recording = false })

it.each(['', 'Old transcript'])('discards obsolete dictation after switching to a live call: %j', async text => {
  let resolve!: (text: string) => void
  const transcription = new Promise<string>(done => { resolve = done })
  const { hook, onTranscript, focusInput } = setup(vi.fn(() => transcription))
  await act(async () => {hook.result.current.dictate()})
  expect(hook.result.current.voiceStatus).toBe('recording')
  await act(async () => {hook.result.current.dictate()})
  expect(hook.result.current.voiceStatus).toBe('transcribing')
  await act(async () => {await hook.result.current.cancel()})
  await act(async () => {resolve(text); await transcription})
  expect(hook.result.current.voiceStatus).toBe('idle')
  expect(onTranscript).not.toHaveBeenCalled()
  expect(focusInput).not.toHaveBeenCalled()
  expect($notifications.get()).toHaveLength(0)
})

it('waits for and releases a pending microphone grant before live capture can start', async () => {
  let grant!: () => void
  const permission = new Promise<void>(done => { grant = done })
  mocks.start.mockImplementationOnce(async () => {await permission; mocks.recording = true})
  const { hook } = setup()
  act(() => hook.result.current.dictate())
  let released = false
  let cancelling!: Promise<void>
  act(() => { cancelling = hook.result.current.cancel().then(() => { released = true }) })
  expect(released).toBe(false)
  await act(async () => {grant(); await cancelling})
  expect(released).toBe(true)
  expect(mocks.recording).toBe(false)
  expect(hook.result.current.voiceStatus).toBe('idle')
  expect($notifications.get()).toHaveLength(0)
})
