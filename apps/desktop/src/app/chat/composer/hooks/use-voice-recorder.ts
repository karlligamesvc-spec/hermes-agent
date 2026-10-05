import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'

import type { VoiceActivityState, VoiceStatus } from '../types'

import { useMicRecorder } from './use-mic-recorder'

interface VoiceRecorderOptions {
  maxRecordingSeconds: number
  onTranscribeAudio?: (audio: Blob) => Promise<string>
  focusInput: () => void
  onTranscript: (text: string) => void
}

export function useVoiceRecorder({
  maxRecordingSeconds,
  onTranscribeAudio,
  focusInput,
  onTranscript
}: VoiceRecorderOptions) {
  const { t } = useI18n()
  const voiceCopy = t.notifications.voice
  const { handle, level, recording } = useMicRecorder(voiceCopy)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const startedAtRef = useRef(0)
  const intervalRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const epochRef = useRef(0)
  const startingRef = useRef<Promise<void> | null>(null)

  const clearTimers = () => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  useEffect(() => () => { epochRef.current++; clearTimers() }, [])

  const cancel = async () => {
    epochRef.current++
    clearTimers()
    handle.cancel()
    setVoiceStatus('idle')
    // Permission may still be pending. Release that late grant before another
    // voice engine opens the device; its transcript no longer owns this draft.
    await startingRef.current?.catch(() => undefined)
    handle.cancel()
  }

  const stop = async () => {
    const epoch = epochRef.current
    clearTimers()
    const result = await handle.stop()

    if (epochRef.current !== epoch) {return}

    if (!result) {
      setVoiceStatus('idle')

      return
    }

    if (!onTranscribeAudio) {
      setVoiceStatus('idle')

      return
    }

    setVoiceStatus('transcribing')

    try {
      const transcript = (await onTranscribeAudio(result.audio)).trim()

      if (epochRef.current !== epoch) {return}

      if (!transcript) {
        notify({ kind: 'warning', title: voiceCopy.noSpeechDetected, message: voiceCopy.tryRecordingAgain })
      } else {
        onTranscript(transcript)
      }
    } catch (error) {
      if (epochRef.current === epoch) {notifyError(error, voiceCopy.transcriptionFailed)}
    } finally {
      if (epochRef.current === epoch) {
        setVoiceStatus('idle')
        focusInput()
      }
    }
  }

  const start = async () => {
    if (!onTranscribeAudio) {
      notify({ kind: 'warning', title: voiceCopy.unavailable, message: voiceCopy.transcriptionUnavailable })

      return
    }

    const epoch = ++epochRef.current

    try {
      const pending = handle.start({ onError: error => {
        if (epochRef.current === epoch) {notifyError(error, voiceCopy.recordingFailed)}
      } })

      startingRef.current = pending
      await pending

      if (epochRef.current !== epoch) {
        handle.cancel()

        return
      }

      startedAtRef.current = Date.now()
      setElapsedSeconds(0)
      setVoiceStatus('recording')
      intervalRef.current = window.setInterval(() => setElapsedSeconds((Date.now() - startedAtRef.current) / 1000), 250)
      const cap = Math.max(1, Math.min(Math.trunc(maxRecordingSeconds), 600))
      timeoutRef.current = window.setTimeout(() => void stop(), cap * 1000)
    } catch (error) {
      if (epochRef.current === epoch) {
        setVoiceStatus('idle')
        notifyError(error, voiceCopy.recordingFailed)
      }
    } finally {
      startingRef.current = null
    }
  }

  const dictate = () => {
    if (recording) {
      void stop()
    } else if (voiceStatus === 'idle' && !startingRef.current) {
      void start()
    }
  }

  const voiceActivityState: VoiceActivityState = {
    elapsedSeconds,
    level,
    status: voiceStatus
  }

  return { cancel, dictate, voiceActivityState, voiceStatus }
}
