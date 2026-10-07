import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { chatMessageText, collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { triggerHaptic } from '@/lib/haptics'
import { adoptSpokenReplySession, markAssistantIdSpoken, resolveSpokenReply } from '@/lib/spoken-reply'
import { CONVERSATION_LEASE, READ_ALOUD_LEASE, syncTtsLease } from '@/lib/tts-lease'
import { toLiveHistory } from '@/lib/voice-live'
import { clearWakeIndicator, syncWakeIndicatorWithVoice } from '@/lib/wake-indicator'
import { $voiceConversationStartRequest, requestVoiceConversationStart, takeVoiceConversationStart } from '@/store/composer'
import { resetBrowseState } from '@/store/composer-input-history'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { refreshVoiceLiveStatus } from '@/store/voice-live'
import { $autoSpeakReplies, $voiceStopPhrase, setAutoSpeakReplies } from '@/store/voice-prefs'
import { resumeWakeAfterVoice } from '@/store/wake-word'

import type { ComposerTarget } from '../focus'
import { onComposerVoiceToggleRequest } from '../focus'
import { useComposerScope } from '../scope'
import type { ChatBarProps } from '../types'

import { useAutoSpeakReplies } from './use-auto-speak-replies'
import { useVoiceConversation } from './use-voice-conversation'
import { useVoiceLiveConversation } from './use-voice-live-conversation'
import { useVoiceRecorder } from './use-voice-recorder'

interface UseComposerVoiceArgs {
  busy: boolean
  clearDraft: () => void
  disabled: boolean
  focusInput: () => void
  insertText: (text: string) => void
  maxRecordingSeconds: number
  /** Interrupt the in-flight agent turn (Stop-button seam) — fired when the
   *  user speaks over the model while it is still generating. */
  onInterrupt?: () => Promise<void> | void
  onSubmit: ChatBarProps['onSubmit']
  onSteer?: ChatBarProps['onSteer']
  onTranscribeAudio: ChatBarProps['onTranscribeAudio']
  sessionId: string | null | undefined
  /** This composer's focus-bus key — voice toggles targeting another
   *  composer (or the active one, when not us) are ignored. */
  target: ComposerTarget
}

/**
 * The composer's voice engine: push-to-talk dictation (transcript → draft), the
 * full voice-conversation loop, and auto-speak of replies. Self-contained — it
 * consumes the draft/submit primitives passed in but nothing depends back on it,
 * so it lifts cleanly out of ChatBar.
 */
export function useComposerVoice({
  busy,
  clearDraft,
  disabled,
  focusInput,
  insertText,
  maxRecordingSeconds,
  onInterrupt,
  onSubmit,
  onSteer,
  onTranscribeAudio,
  sessionId,
  target
}: UseComposerVoiceArgs) {
  const { t } = useI18n()
  // A tile's composer speaks ITS transcript, not the primary chat's.
  const { $messages } = useComposerScope()
  const [voiceConversationActive, setVoiceConversationActive] = useState(false)
  const [voiceStarting, setVoiceStarting] = useState(false)
  const activationEpochRef = useRef(0)
  // Native admission is resolved before either microphone hook can activate.
  const [liveEngineActive, setLiveEngineActive] = useState(false)
  const ownsWakeIndicatorRef = useRef(false)
  const previousSessionIdRef = useRef(sessionId)
  const voiceStartRequest = useStore($voiceConversationStartRequest)

  // eslint-disable-next-line no-restricted-syntax -- session-id adopt token, not an atom mirror
  useEffect(() => {
    adoptSpokenReplySession(previousSessionIdRef.current, sessionId)
    previousSessionIdRef.current = sessionId
  }, [sessionId])

  const { cancel: cancelDictation, dictate, voiceActivityState, voiceStatus } = useVoiceRecorder({
    focusInput,
    maxRecordingSeconds,
    onTranscript: insertText,
    onTranscribeAudio
  })

  /** Auto-speak selector: the latest unspoken reply only — a backlog collapses to the newest. */
  const pendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
    const spoken = resolveSpokenReply(sessionId, messages)

    if (!last || last.id === spoken?.id) {
      return null
    }

    const text = chatMessageText(last).trim()

    if (!text) {
      return null
    }

    return {
      id: last.id,
      pending: Boolean(last.pending),
      text
    }
  }

  /**
   * Voice-conversation selector: every unspoken assistant bubble of the turn,
   * in order — narration interims AND the final answer, not just whichever
   * bubble happens to be last. See `collectUnspokenTurnSpeech`.
   */
  const pendingTurnResponse = () => {
    const messages = $messages.get()

    return collectUnspokenTurnSpeech(messages, resolveSpokenReply(sessionId, messages)?.id ?? null)
  }

  // A live tool result belongs to the newly accepted user turn. An interrupted
  // earlier turn may append another assistant row after our spoken cursor.
  const pendingLiveTurnResponse = () => collectUnspokenTurnSpeech($messages.get(), null)

  const consumePendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (last) {
      markAssistantIdSpoken(sessionId, messages, last.id)
    }
  }

  const submitVoiceTurn = async (text: string) => {
    if (busy) {
      return
    }

    triggerHaptic('submit')
    resetBrowseState(sessionId)
    clearDraft()
    await onSubmit(text)
  }

  /** A GPT-Live delegation → Hermes turn. The bubble and the persisted row are
   *  what the user said; the transcript window rides the model input only. */
  const submitLiveDelegation = async (text: string, voiceContext: string) => {
    triggerHaptic('submit')
    resetBrowseState(sessionId)
    clearDraft()

    // Deliver an interjection to the same primary turn at a safe boundary.
    // The primary decides whether it changes the task; hearing speech alone
    // must not press Stop or discard completed work.
    if (busy && await onSteer?.(text)) {return true}

    return await onSubmit(text, { surface: 'voice-live', voiceContext })
  }

  /** Recent text turns of this chat, as GPT-Live startup history. */
  const seedLiveHistory = () =>
    toLiveHistory(
      $messages
        .get()
        .filter(m => !m.hidden && (m.role === 'user' || m.role === 'assistant'))
        .map(m => ({ role: m.role as 'assistant' | 'user', text: chatMessageText(m) }))
    )

  /** The tool Hermes is running right now, for quiet progress in the voice. */
  const activeToolLabel = () => {
    const last = $messages.get().findLast(m => m.role === 'assistant' && !m.hidden)
    const running = last?.parts.findLast(part => part.type === 'tool-call' && part.result === undefined)

    return running && running.type === 'tool-call' ? running.toolName : null
  }

  const wakePausedRef = useRef(false)
  // Resolves once the in-flight wake.pause round-trip completes (mic released by
  // the wake listener). The conversation awaits this before opening its own mic
  // so the two never contend for the device — on Windows especially, opening the
  // capture device while the wake listener still holds it makes getUserMedia
  // fail and the conversation never starts listening.
  const wakePauseBarrierRef = useRef<Promise<void> | null>(null)

  const chainedConversation = useVoiceConversation({
    busy,
    consumePendingResponse,
    enabled: voiceConversationActive && !liveEngineActive,
    onFatalError: () => setVoiceConversationActive(false),
    // Speaking over the model mid-generation interrupts the in-flight turn —
    // the same seam as the Stop button — so the interjection becomes the next
    // turn instead of waiting behind a reply the user already rejected.
    onInterrupt,
    // A spoken stop command ("stop", "never mind", "goodbye", …) ends the
    // hands-free conversation. Flipping the flag is the authoritative off
    // switch — the enabled=false prop + effect below drive conversation.end()
    // teardown (mic close, wake re-arm).
    onStopWord: () => setVoiceConversationActive(false),
    onSubmit: submitVoiceTurn,
    onTranscribeAudio,
    pendingResponse: pendingTurnResponse,
    // Before the conversation opens the mic, wait for any in-flight wake.pause
    // to finish releasing the capture device (see wakePauseBarrierRef).
    beforeMicOpen: async () => { await cancelDictation(); await wakePauseBarrierRef.current }
  })

  const liveConversation = useVoiceLiveConversation({
    activeToolLabel,
    beforeMicOpen: async () => { await cancelDictation(); await wakePauseBarrierRef.current },
    busy,
    consumePendingResponse,
    enabled: voiceConversationActive && liveEngineActive,
    onFatalError: () => setVoiceConversationActive(false),
    onStopWord: () => setVoiceConversationActive(false),
    onSubmit: submitLiveDelegation,
    pendingResponse: pendingLiveTurnResponse,
    seedHistory: seedLiveHistory
  })

  const conversation = liveEngineActive ? liveConversation : chainedConversation

  /** APEX uses native Qwen voice without exposing an engine choice. Admission
   * is profile-scoped; an unavailable service never opens a different engine. */
  const activateConversation = useCallback(async () => {
    const epoch = ++activationEpochRef.current
    setVoiceStarting(true)
    let status

    try {
      status = await refreshVoiceLiveStatus()
    } catch (error) {
      if (activationEpochRef.current === epoch) {
        setVoiceStarting(false)
        notifyError(error, t.composer.voiceUnavailable)
      }

      return
    }

    if (activationEpochRef.current !== epoch) {return}
    setVoiceStarting(false)

    // A scope change makes the status request return null. Never start against
    // the profile/account that replaced the one clicked by the user.
    if (!status) {return}
    const available = status.qwenAvailable ?? (status.mode === 'qwen-realtime' && status.available)

    if (!available) {
      notify({
        id: 'voice-live-unavailable',
        kind: 'warning',
        message: t.composer.voiceUnavailable
      })

      return
    }

    setLiveEngineActive(true)
    setVoiceConversationActive(true)
  }, [t])

  useEffect(() => {
    if (!voiceConversationActive) {
      // Prefetch admission; the explicit start still awaits scope-safe status.
      void refreshVoiceLiveStatus().catch(() => undefined)
    }
  }, [voiceConversationActive])

  // eslint-disable-next-line no-restricted-syntax -- ownership token used only by unmount cleanup
  useEffect(() => {
    if (target !== 'main') {
      return
    }

    if (syncWakeIndicatorWithVoice(voiceConversationActive, conversation.status)) {
      ownsWakeIndicatorRef.current = voiceConversationActive
    }
  }, [conversation.status, target, voiceConversationActive])

  useEffect(
    () => () => {
      if (ownsWakeIndicatorRef.current) {
        clearWakeIndicator()
      }
    },
    []
  )

  // The `composer.voice` hotkey (Ctrl+B) toggles the conversation. Starting
  // with STT unconfigured lets the conversation surface its own "configure
  // speech-to-text" notice rather than silently no-opping.
  const toggleVoiceConversation = useCallback(() => {
    if (disabled) {
      return
    }

    if (voiceConversationActive || voiceStarting) {
      activationEpochRef.current++
      setVoiceStarting(false)
      setVoiceConversationActive(false)
      void conversation.end()
    } else {
      void activateConversation()
    }
  }, [activateConversation, conversation, disabled, voiceConversationActive, voiceStarting])

  useEffect(
    () => onComposerVoiceToggleRequest(toggled => toggled === target && toggleVoiceConversation()),
    [target, toggleVoiceConversation]
  )

  useEffect(() => {
    if (target === 'main' && !disabled && takeVoiceConversationStart(voiceStartRequest) && !voiceConversationActive && !voiceStarting) {
      void activateConversation()
    }
  }, [activateConversation, disabled, target, voiceConversationActive, voiceStartRequest, voiceStarting])

  const resumeWakeIfPaused = useCallback(() => {
    if (!wakePausedRef.current) {
      return
    }

    wakePausedRef.current = false
    wakePauseBarrierRef.current = null
    // Reconcile, don't just resume: the wake word is a persistent setting, so
    // ending a voice chat must re-arm the listener whenever config says
    // enabled — including when the raw resume loses the mic-release race.
    void resumeWakeAfterVoice()
  }, [])

  // The ref is a request token (did WE issue wake.pause?), not an atom mirror —
  // it guards resumeWakeIfPaused from resuming a detector another surface owns.
  const pauseWakeForVoice = useCallback(() => {
    wakePausedRef.current = true

    const barrier = (async () => {
      try {
        await $gateway.get()?.request('wake.pause', {})
      } catch {
        // No wake listener / older backend — nothing held the mic.
      }
    })()

    wakePauseBarrierRef.current = barrier

    return barrier
  }, [])

  useEffect(() => {
    if (voiceConversationActive) {
      pauseWakeForVoice()
    } else {
      resumeWakeIfPaused()
    }
  }, [pauseWakeForVoice, resumeWakeIfPaused, voiceConversationActive])

  // 'Say "stop" to end the voice chat.' notice when the conversation starts.
  // Phrase comes from voice.stop_phrases (first entry) so a custom phrase
  // renders correctly; a null phrase (stop_phrases: []) shows no notice.
  useEffect(() => {
    if (!voiceConversationActive) {
      return
    }

    const phrase = $voiceStopPhrase.get()

    if (phrase) {
      notify({
        id: 'voice-stop-hint',
        kind: 'info',
        icon: 'mic',
        message: t.notifications.voice.sayStopToEnd(phrase)
      })
    }
  }, [t, voiceConversationActive])

  useEffect(() => () => {
    activationEpochRef.current++
    resumeWakeIfPaused()
  }, [resumeWakeIfPaused])

  // Speech-output toggles are TTS warm-up / release signals. Entering a voice
  // conversation acquires this window's lease (pre-loads the engine so the
  // first spoken reply doesn't start with dead air); ending it releases the
  // lease, and the backend unloads resident local models once no surface holds
  // one. Fire-and-forget — the toggle never waits on or fails from this.
  useEffect(() => {
    void syncTtsLease(CONVERSATION_LEASE, voiceConversationActive && !liveEngineActive)
  }, [liveEngineActive, voiceConversationActive])

  useEffect(() => () => void syncTtsLease(CONVERSATION_LEASE, false), [])

  // "Read replies aloud" is the same signal, held for as long as the toggle is
  // on (it mirrors voice.auto_tts, so this also warms at startup when the
  // preference is already set).
  const autoSpeakReplies = useStore($autoSpeakReplies)

  useEffect(() => {
    void syncTtsLease(READ_ALOUD_LEASE, autoSpeakReplies)
  }, [autoSpeakReplies])

  // Explicit start/end for the on-screen conversation controls (the hotkey uses
  // the gated toggle above).
  const startConversation = useCallback(() => {
    // Keep the controller mounted behind task/settings pages during the call.
    if (target === 'main') {
      requestVoiceConversationStart()
    }

    void activateConversation()
  }, [activateConversation, target])

  const endConversation = useCallback(() => {
    activationEpochRef.current++
    setVoiceStarting(false)
    setVoiceConversationActive(false)
    void conversation.end()
  }, [conversation])

  const handleToggleAutoSpeak = useCallback(() => {
    void setAutoSpeakReplies(!$autoSpeakReplies.get()).catch(error =>
      notifyError(error, t.settings.config.autosaveFailed)
    )
  }, [t])

  useAutoSpeakReplies({
    conversationActive: voiceConversationActive,
    failureLabel: t.assistant.thread.readAloudFailed,
    markSpoken: consumePendingResponse,
    pendingReply: pendingResponse,
    sessionId
  })

  return {
    conversation,
    dictate: () => {
      if (!voiceConversationActive && !voiceStarting) {dictate()}
    },
    endConversation,
    handleToggleAutoSpeak,
    startConversation,
    voiceActivityState,
    voiceTranscript: liveEngineActive ? liveConversation.transcript : [],
    voiceConversationActive: voiceConversationActive || voiceStarting,
    voiceStatus
  }
}
