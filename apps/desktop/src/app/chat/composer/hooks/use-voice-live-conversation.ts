import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { QwenRealtimeSession } from '@/lib/qwen-realtime'
import { sanitizeTextForSpeech } from '@/lib/speech-text'
import { type LiveHistoryMessage, type LiveTranscriptFragment } from '@/lib/voice-live'
import { isVoiceStopCommand } from '@/lib/voice-stop-word'
import { appendVoiceTranscript } from '@/lib/voice-transcript'
import { notify, notifyError } from '@/store/notifications'

import type { ConversationStatus } from './use-voice-conversation'


interface PendingVoiceResponse {
  id: string
  pending: boolean
  text: string
}

interface VoiceLiveConversationOptions {
  busy: boolean
  enabled: boolean
  onFatalError?: () => void
  onStopWord?: () => void
  /** Submit a Hermes turn: `text` is the user's last words (the bubble and the
   *  persisted row), `voiceContext` the recent spoken exchange for the model. */
  onSubmit: (text: string, voiceContext: string) => Promise<boolean | void> | boolean | void
  pendingResponse: () => PendingVoiceResponse | null
  consumePendingResponse: () => void
  /** Text turns to seed the live model with when the session opens. */
  seedHistory: () => LiveHistoryMessage[]
  /** Names of tools currently running in the turn (quiet progress for the voice). */
  activeToolLabel?: () => null | string
  beforeMicOpen?: () => Promise<void> | void
}

/** Turn transcript fragments into the Hermes turn: `prompt` is what the user
 *  last said (the persisted user row), `context` the recent spoken exchange
 *  that rides the model input only (see tools/voice_live.py). */
export function delegationPrompt(context: LiveTranscriptFragment[]): { context: string; prompt: string } {
  const turns: Array<{ speaker: 'assistant' | 'user'; text: string; turnId?: string }> = []

  for (const fragment of context) {
    const last = turns.at(-1)

    if (last && last.speaker === fragment.speaker && last.turnId === fragment.turnId) {
      last.text += fragment.text
    } else {
      turns.push({ speaker: fragment.speaker, text: fragment.text, turnId: fragment.turnId })
    }
  }

  const lastUser = [...turns].reverse().find(turn => turn.speaker === 'user')
  const prompt = (lastUser?.text ?? '').replace(/\s+/g, ' ').trim()

  const transcript = turns
    .map(turn => `${turn.speaker === 'user' ? 'User' : 'Voice assistant'}: ${turn.text.replace(/\s+/g, ' ').trim()}`)
    .filter(line => !line.endsWith(': '))
    .join('\n')

  return { context: transcript, prompt: prompt || transcript.slice(-400) }
}

/**
 * APEX realtime conversation — Qwen is selected internally, independently of
 * legacy CLI engine preferences. The public shape matches `useVoiceConversation`.
 *
 * Status mapping: `listening` = session up, voice idle; `speaking` = the
 * remote track is producing audio; `thinking` = a delegation is in flight in
 * Hermes. There is no `transcribing` phase: the voice model owns speech.
 */
export function useVoiceLiveConversation({
  busy,
  enabled,
  onFatalError,
  onStopWord,
  onSubmit,
  pendingResponse,
  consumePendingResponse,
  seedHistory,
  activeToolLabel,
  beforeMicOpen
}: VoiceLiveConversationOptions) {
  const { t } = useI18n()
  const voiceCopy = t.notifications.voice
  const [status, setStatus] = useState<ConversationStatus>('idle')
  const [muted, setMuted] = useState(false)
  const [level, setLevel] = useState(0)
  const [transcript, setTranscript] = useState<LiveTranscriptFragment[]>([])
  // Mirrors delegationRef for the reply-drive effect: a new delegation must
  // restart the feed loop, and a ref write alone does not re-render.
  const [activeDelegation, setActiveDelegation] = useState<null | string>(null)

  const sessionRef = useRef<
    | null
    | (Pick<QwenRealtimeSession, 'start' | 'close' | 'think' | 'speak' | 'setMuted' | 'instruct'> & {
        finishDelegation?: (id: string) => void
      })
  >(null)

  // Bumped by every start/end so an in-flight start() that lost the race
  // (StrictMode double-effect, quick toggle) closes its session instead of
  // leaving a second billed one running.
  const startEpochRef = useRef(0)
  const startingRef = useRef(false)
  // Session creation/resume and prompt.submit can outlive a transient idle
  // view. Only the accepted submission's actual answer completes delegation.
  const submissionPendingRef = useRef(false)
  const enabledRef = useRef(enabled)
  const busyRef = useRef(busy)
  const speakingRef = useRef(false)
  const delegationRef = useRef<null | string>(null)
  const spokenLengthRef = useRef(0)
  const spokenResponseIdRef = useRef<null | string>(null)
  const lastToolLabelRef = useRef<null | string>(null)
  const wasEnabledRef = useRef(enabled)

  const latest = useRef({
    activeToolLabel,
    beforeMicOpen,
    onFatalError,
    onStopWord,
    onSubmit,
    pendingResponse,
    consumePendingResponse,
    seedHistory
  })

  latest.current = {
    activeToolLabel,
    beforeMicOpen,
    onFatalError,
    onStopWord,
    onSubmit,
    pendingResponse,
    consumePendingResponse,
    seedHistory
  }

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const setDelegation = useCallback((id: null | string) => {
    delegationRef.current = id
    setActiveDelegation(id)
  }, [])

  const refreshStatus = useCallback(() => {
    if (!sessionRef.current) {
      setStatus('idle')

      return
    }

    if (speakingRef.current) {
      setStatus('speaking')
    } else if (delegationRef.current) {
      setStatus('thinking')
    } else {
      setStatus('listening')
    }
  }, [])

  const end = useCallback(async () => {
    startEpochRef.current += 1
    startingRef.current = false

    const session = sessionRef.current
    sessionRef.current = null
    setDelegation(null)
    spokenResponseIdRef.current = null
    spokenLengthRef.current = 0
    speakingRef.current = false
    session?.close()
    setMuted(false)
    setLevel(0)
    setStatus('idle')
  }, [setDelegation])

  const start = useCallback(async () => {
    if (sessionRef.current || startingRef.current) {
      return
    }

    startingRef.current = true
    setTranscript([])
    const epoch = ++startEpochRef.current

    try {
      await latest.current.beforeMicOpen?.()
    } catch {
      // A wake-pause failure must not block an explicit start.
    }

    if (!enabledRef.current || startEpochRef.current !== epoch) {
      startingRef.current = false

      return
    }

    let fatalErrorReported = false

    const session = new QwenRealtimeSession({
      // Qwen's user fragment is a completed ASR item, not a partial delta.
      // Judge that entire turn immediately: the model may say goodbye without
      // delegating, and joining adjacent ASR turns can swallow the stop request.
      onTranscript: fragment => {
        if (startEpochRef.current !== epoch) {return}
        setTranscript(current => appendVoiceTranscript(current, fragment, 200))

        if (fragment.speaker !== 'user') {
          return
        }

        if (sessionRef.current === session && isVoiceStopCommand(fragment.text)) {
          void end()
          latest.current.onStopWord?.()
        }
      },
      onClosed: (reason, usageSeconds) => {
        if (sessionRef.current !== session) {
          return
        }

        sessionRef.current = null
        setDelegation(null)
        setStatus('idle')

        if (reason !== 'close_requested') {
          if (!fatalErrorReported) {
            notify({
              kind: 'warning',
              message: usageSeconds != null ? `${reason} (${Math.round(usageSeconds)}s)` : reason,
              title: voiceCopy.liveEnded
            })
          }

          latest.current.onFatalError?.()
        }
      },
      onDelegation: (delegationId, context) => {
        if (sessionRef.current !== session) {
          return
        }

        const { context: voiceContext, prompt } = delegationPrompt(context)

        // A spoken stop command ends the conversation instead of becoming a turn.
        if (prompt && isVoiceStopCommand(prompt)) {
          void end()
          latest.current.onStopWord?.()

          return
        }

        setDelegation(delegationId)
        spokenResponseIdRef.current = null
        spokenLengthRef.current = 0
        lastToolLabelRef.current = null
        submissionPendingRef.current = true
        latest.current.consumePendingResponse()
        refreshStatus()
        void (async () => {
          if (sessionRef.current !== session || delegationRef.current !== delegationId) {return}
          const accepted = await latest.current.onSubmit(prompt, voiceContext)

          if (accepted === false) {throw new Error('APEX did not accept the voice request.')}

          if (sessionRef.current === session && delegationRef.current === delegationId) {
            submissionPendingRef.current = false
          }
        })().catch(error => {
          if (sessionRef.current !== session || delegationRef.current !== delegationId) {return}
          notifyError(error, voiceCopy.liveDelegationFailed)
          session.speak(delegationId, 'Sorry, I could not reach Hermes for that request.')
          session.finishDelegation?.(delegationId)
          setDelegation(null)
          refreshStatus()
        })
      },
      onError: (message, fatal) => {
        if (sessionRef.current !== session) {return}
        fatalErrorReported ||= fatal
        notify({ kind: fatal ? 'error' : 'warning', message, title: voiceCopy.liveError })
      },
      onSpeakingChange: speaking => {
        speakingRef.current = speaking
        setLevel(speaking ? 0.6 : 0)
        refreshStatus()
      }
    })

    sessionRef.current = session
    startingRef.current = false
    setMuted(false)
    setStatus('thinking')

    try {
      await session.start(latest.current.seedHistory())

      if (sessionRef.current !== session || startEpochRef.current !== epoch) {
        session.close()

        return
      }

      refreshStatus()
    } catch (error) {
      if (sessionRef.current === session) {
        sessionRef.current = null
      }

      session.close()

      if (startEpochRef.current !== epoch) {
        return
      }

      if (!fatalErrorReported) {notifyError(error, voiceCopy.couldNotStartSession)}
      setStatus('idle')
      latest.current.onFatalError?.()
    }
  }, [
    end,
    refreshStatus,
    setDelegation,
    voiceCopy.couldNotStartSession,
    voiceCopy.liveDelegationFailed,
    voiceCopy.liveEnded,
    voiceCopy.liveError
  ])

  // Drive the reply back into the voice: stream commentary as Hermes writes
  // it (sentence-chunked), quiet tool progress as thinking appends, and clear
  // the delegation when the turn settles.
  // eslint-disable-next-line no-restricted-syntax -- turn-coordination refs (delegation id / spoken cursor), not atom mirrors
  useEffect(() => {
    const session = sessionRef.current
    const delegationId = delegationRef.current

    if (!session || !delegationId) {
      return undefined
    }

    const tick = () => {
      if (sessionRef.current !== session || delegationRef.current !== delegationId) {
        return
      }

      if (submissionPendingRef.current) {return}

      const tool = latest.current.activeToolLabel?.() ?? null

      if (tool && tool !== lastToolLabelRef.current) {
        lastToolLabelRef.current = tool
        session.think(delegationId, `Hermes is working: ${tool}. Not done yet.`)
      }

      const response = latest.current.pendingResponse()

      if (response) {
        if (spokenResponseIdRef.current !== response.id) {
          spokenResponseIdRef.current = response.id
          spokenLengthRef.current = 0
        }

        const spoken = sanitizeTextForSpeech(response.text)

        // Append only completed sentences while streaming; the tail lands on settle.
        if (response.pending || busyRef.current) {
          const boundary = spoken.lastIndexOf('. ', spoken.length - 2)
          const cut = boundary > spokenLengthRef.current ? boundary + 1 : spokenLengthRef.current

          if (cut > spokenLengthRef.current) {
            session.speak(delegationId, spoken.slice(spokenLengthRef.current, cut))
            spokenLengthRef.current = cut
          }

          return
        }

        if (spoken.length > spokenLengthRef.current) {
          session.speak(delegationId, spoken.slice(spokenLengthRef.current))
          spokenLengthRef.current = spoken.length
        }

        session.finishDelegation?.(delegationId)
        latest.current.consumePendingResponse()
        setDelegation(null)
        refreshStatus()

        return
      }

      // No reply is not a completion receipt. In particular, re-homing a
      // new chat can briefly expose idle/empty state while its tool runs.
      // Keep the call pending until its answer, explicit submit failure, a
      // newer request, or the user ending this voice session.
    }

    const timer = window.setInterval(tick, 200)
    tick()

    return () => window.clearInterval(timer)
  }, [activeDelegation, busy, refreshStatus, setDelegation, status])

  const toggleMute = useCallback(() => {
    setMuted(value => {
      const next = !value
      sessionRef.current?.setMuted(next)

      return next
    })
  }, [])

  /** No explicit turn boundary in full duplex; a nudge tells the voice to answer now. */
  const stopTurn = useCallback(() => {
    sessionRef.current?.instruct('The user has finished speaking. Respond now to what they said.')
  }, [])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      void start()
    }

    if (!enabled && wasEnabledRef.current) {
      void end()
    }

    wasEnabledRef.current = enabled
  }, [enabled, end, start])

  useEffect(() => () => void end(), [end])

  return { end, level, muted, start, status, stopTurn, toggleMute, transcript }
}
