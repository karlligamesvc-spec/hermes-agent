import { getApiRequestConnection, getApiRequestProfile } from '@/api/client'
import type { LiveHistoryMessage, LiveTranscriptFragment, VoiceLiveHandlers } from '@/lib/voice-live'
import { VoicePcmTurn } from '@/lib/voice-pcm-turn'
import { resolveSpeakStreamUrl } from '@/lib/voice-playback'
import { appendVoiceTranscript } from '@/lib/voice-transcript'

/** Float microphone frames → 16 kHz mono PCM16. Carries phase across chunks. */
export class Pcm16Encoder {
  private position = 0

  constructor(private readonly sampleRate: number) {}

  encode(input: Float32Array): string {
    const samples: number[] = []
    const step = this.sampleRate / 16_000

    while (this.position < input.length) {
      samples.push(Math.max(-1, Math.min(1, input[Math.floor(this.position)] ?? 0)))
      this.position += step
    }

    this.position -= input.length
    const bytes = new Uint8Array(samples.length * 2)
    const view = new DataView(bytes.buffer)
    samples.forEach((sample, index) => view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true))

    return btoa(String.fromCharCode(...bytes))
  }
}

export interface QwenEvent {
  type: string
  item_id?: string
  response_id?: string
  response?: { id?: string }
  session?: { turn_detection?: unknown }
  delta?: string
  transcript?: string
  name?: string
  call_id?: string
  arguments?: string
  error?: { message?: string; code?: string }
}

/** ASR submits every utterance to the primary assistant; Qwen only reads its result. */
export class QwenRealtimeSession {
  private readonly scope = JSON.stringify([getApiRequestConnection(), getApiRequestProfile()])
  private socket: WebSocket | null = null
  private microphone: MediaStream | null = null
  private context: AudioContext | null = null
  private recorder: ScriptProcessorNode | null = null
  private input: MediaStreamAudioSourceNode | null = null
  private readonly playing = new Set<AudioBufferSourceNode>()
  private cursor = 0
  private muted = false
  private closed = false
  private responding = false
  private responseRequested = false
  private responsePending = false
  private userSpeaking = false
  private responseId: string | null = null
  private readonly cancelledResponses = new Set<string>()
  private readonly completedResponses = new Set<string>()
  private readbackResponseId: string | null = null
  private capture: VoicePcmTurn | null = null
  private keepalive: number | null = null
  private ready = false
  private reply = ''
  private callId: string | null = null
  private transcript: LiveTranscriptFragment[] = []
  private nextTurn = 0
  private readonly turns = new Map<string, { order: number; completed: boolean }>()
  private inputTurn: string | null = null
  private readonly pendingInputTurns: string[] = []
  private delegatedTurnOrder = 0

  constructor(private readonly handlers: VoiceLiveHandlers) {}

  private reserveTurn(id: string): { order: number; completed: boolean } {
    const existing = this.turns.get(id)

    if (existing) {return existing}

    const turn = { order: ++this.nextTurn, completed: false }
    this.turns.set(id, turn)

    if (this.turns.size > 200) {
      this.turns.delete(this.turns.keys().next().value!)
    }

    return turn
  }

  private scopeMatches(): boolean {
    return this.scope === JSON.stringify([getApiRequestConnection(), getApiRequestProfile()])
  }

  private send(event: Record<string, unknown>): void {
    if (!this.scopeMatches()) {
      this.close('account_changed')

      return
    }

    if (!this.closed && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event))
    }
  }

  async start(history: LiveHistoryMessage[] = []): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })

      if (this.closed || !this.scopeMatches()) {
        this.close('account_changed')
        stream.getTracks().forEach(track => track.stop())

        return
      }

      this.microphone = stream
      this.context = new AudioContext()
      await this.context.resume()
      const base = await resolveSpeakStreamUrl()

      if (this.closed || !this.scopeMatches()) {
        this.close('account_changed')

        return
      }

      if (!base) {
        throw new Error('无法连接当前助手的语音服务。')
      }

      const url = new URL(base)
      url.pathname = url.pathname.replace(/\/speak-stream$/, '/qwen-realtime')
      const socket = new WebSocket(url)
      this.socket = socket
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('千问语音连接超时，请重试。')), 25_000)

        const finish = (error?: Error) => {
          window.clearTimeout(timeout)

          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }

        socket.onopen = () => this.send({ type: 'apex.start', history })

        socket.onmessage = message => {
          try {
            const event = JSON.parse(String(message.data)) as QwenEvent

            if (event.type === 'session.updated') {
              if (event.session?.turn_detection !== null) {
                throw new Error('请更新 APEX AI 引擎后再使用统一主助手语音。')
              }
              this.ready = true
              finish()
            }

            if (event.type === 'error' && !this.ready) {
              finish(new Error(event.error?.message ?? '千问实时语音暂不可用。'))
            }

            this.receive(event)
          } catch {
            finish(new Error('语音服务返回了无效数据。'))
            this.handlers.onError('语音服务返回了无效数据。', true)
            this.close('invalid_response')
          }
        }

        socket.onerror = () => {
          finish(new Error('千问语音连接失败，请重试。'))
          this.handlers.onError('千问语音连接失败，请重试。', true)
          this.close('connection_error')
        }

        socket.onclose = () => {
          if (!this.ready) {
            finish(new Error('千问语音连接已关闭。'))
          }

          this.close('connection_closed')
        }
      })

      if (this.closed || !this.context) {
        return
      }

      const encoder = new Pcm16Encoder(this.context.sampleRate)
      this.input = this.context.createMediaStreamSource(stream)
      this.recorder = this.context.createScriptProcessor(2048, 1, 1)

      this.capture = new VoicePcmTurn(this.context.sampleRate, {
        start: () => {
          this.inputTurn = `user-${this.nextTurn + 1}`
          this.reserveTurn(`user:${this.inputTurn}`)
          this.userSpeaking = true
          this.responsePending = false
          this.stopAudio()
          this.send({ type: 'input_audio_buffer.clear' })

          if (this.responding || this.responseRequested) {
            if (this.responseId) {this.cancelledResponses.add(this.responseId)}
            this.send({ type: 'response.cancel' })
          }
        },
        append: samples => this.send({ type: 'input_audio_buffer.append', audio: encoder.encode(samples) }),
        commit: () => {
          this.userSpeaking = false
          if (this.inputTurn) {this.pendingInputTurns.push(this.inputTurn)}
          this.send({ type: 'input_audio_buffer.commit' })
        }
      })
      this.recorder.onaudioprocess = event => {
        if (!this.muted) {this.capture?.feed(event.inputBuffer.getChannelData(0))}
      }
      // Keep the provider's audio channel alive during long primary tool runs.
      // This uncommitted silence never becomes a user turn or model request.
      this.keepalive = window.setInterval(() => {
        if (!this.userSpeaking) {
          this.send({ type: 'input_audio_buffer.clear' })
          this.send({ type: 'input_audio_buffer.append', audio: btoa('\0'.repeat(3200)) })
        }
      }, 30_000)

      this.input.connect(this.recorder)
      this.recorder.connect(this.context.destination)
    } catch (error) {
      this.close()
      throw error
    }
  }

  receive(event: QwenEvent): void {
    if (this.closed) {return}
    if (!this.scopeMatches()) {
      this.close('account_changed')

      return
    }

    if (event.type === 'error') {
      if (event.error?.code === 'response_cancel_not_active' ||
          (event.error?.code === 'invalid_value' && event.error.message === 'Conversation has no active response.')) {return}
      this.handlers.onError(event.error?.message ?? '千问实时语音暂不可用。', true)
      this.close('voice_error')

      return
    }

    if (event.type === 'input_audio_buffer.committed' && event.item_id) {
      // Bind delayed ASR to the order reserved when capture began.
      const committed = this.pendingInputTurns.shift()
      const reserved = committed && this.turns.get(`user:${committed}`)
      if (reserved) {this.turns.set(`user:${event.item_id}`, reserved)}

      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript?.trim()) {
      const turnId = event.item_id ?? this.inputTurn ?? `user-${this.nextTurn + 1}`
      const turn = this.reserveTurn(`user:${turnId}`)
      if (turn.completed) {return}
      turn.completed = true
      const fragment: LiveTranscriptFragment = { speaker: 'user', text: event.transcript, startMs: Date.now(), endMs: Date.now(),
        turnId, turnOrder: turn.order }
      this.transcript = appendVoiceTranscript(this.transcript, fragment, 80)
      this.handlers.onTranscript?.(fragment)
      // Closing a call from its completed ASR must not also submit a chat turn.
      if (this.closed) {return}
      if (turn.order < this.delegatedTurnOrder) {return}
      this.delegatedTurnOrder = turn.order
      this.callId = turnId
      this.reply = ''
      this.handlers.onDelegation(turnId, [...this.transcript])

      return
    }

    if (event.type === 'response.created') {
      const id = event.response?.id
      if (id && this.completedResponses.has(id)) {return}
      const requested = this.responseRequested
      this.responseRequested = false
      this.responding = true
      this.responseId = id ?? null
      this.readbackResponseId = requested ? this.responseId : null
      this.reserveTurn(`assistant:${id ?? 'assistant'}`)
      if (!requested || this.userSpeaking) {
        if (id) {this.cancelledResponses.add(id)}
        this.send({ type: 'response.cancel' })
      }

      return
    }

    if (event.type === 'response.done') {
      const id = event.response?.id
      if (!id || this.completedResponses.has(id) || id !== this.responseId) {return}
      this.completedResponses.add(id)
      this.responding = false
      this.responseRequested = false
      this.responseId = this.readbackResponseId = null
      this.flushPendingResponse()

      return
    }

    const id = event.response_id ?? this.responseId
    if (!id || id !== this.readbackResponseId || this.cancelledResponses.has(id)) {return}
    if (event.type === 'response.audio.delta' && event.delta) {
      this.play(event.delta)
    } else if (event.type === 'response.audio_transcript.delta' && event.delta) {
      const turn = this.reserveTurn(`assistant:${id}`)
      const fragment: LiveTranscriptFragment = { speaker: 'assistant', text: event.delta, startMs: Date.now(), endMs: Date.now(),
        turnId: id, turnOrder: turn.order }
      this.transcript = appendVoiceTranscript(this.transcript, fragment, 80)
      this.handlers.onTranscript?.(fragment)
    }
  }

  private play(encoded: string): void {
    if (!this.context) {
      return
    }

    const binary = atob(encoded)
    const pcm = new DataView(Uint8Array.from(binary, char => char.charCodeAt(0)).buffer)
    const buffer = this.context.createBuffer(1, Math.floor(binary.length / 2), 24_000)
    const data = buffer.getChannelData(0)

    for (let i = 0; i < data.length; i += 1) {
      data[i] = pcm.getInt16(i * 2, true) / 32768
    }

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    const start = Math.max(this.cursor, this.context.currentTime)
    this.cursor = start + buffer.duration
    this.playing.add(source)
    this.handlers.onSpeakingChange?.(true)

    source.onended = () => {
      this.playing.delete(source)
      source.disconnect()

      if (!this.playing.size) {
        this.handlers.onSpeakingChange?.(false)
      }
    }

    source.start(start)
  }

  private stopAudio(): void {
    for (const source of this.playing) {
      source.onended = null
      source.stop()
      source.disconnect()
    }

    this.playing.clear()
    this.cursor = 0
    this.handlers.onSpeakingChange?.(false)
  }

  think(_delegationId: string | null, _content: string): void {
    // Progress remains visible in the normal chat; never report a tool as finished.
  }

  speak(delegationId: string | null, content: string): void {
    if (delegationId === this.callId) {
      this.reply += content
    }
  }

  finishDelegation(delegationId: string): void {
    if (delegationId !== this.callId) {
      return
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `APEX 主助手已返回以下待朗读正文：\n${this.reply || '本次请求未返回可播报结果，请查看 APEX 对话中的状态。'}` }]
      }
    })
    this.callId = null
    this.reply = ''
    this.responsePending = true
    this.flushPendingResponse()
  }

  private flushPendingResponse(): void {
    if (this.closed || this.callId || !this.responsePending || this.responding || this.responseRequested || this.userSpeaking) {
      return
    }

    // Reserve the slot before response.created arrives, so another completed
    // tool cannot start a second response in the acknowledgement gap.
    this.responsePending = false
    this.responseRequested = true
    this.send({ type: 'response.create' })
  }

  instruct(_content: string): void {
    this.capture?.finish()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) {
      this.capture?.reset()
      this.userSpeaking = false
      this.send({ type: 'input_audio_buffer.clear' })
    }
    this.microphone?.getAudioTracks().forEach(track => {
      track.enabled = !muted
    })
  }

  close(reason = 'close_requested'): void {
    if (this.closed) {
      return
    }

    this.closed = true
    if (this.keepalive !== null) {window.clearInterval(this.keepalive)}
    this.keepalive = null
    this.capture?.reset()
    this.stopAudio()
    this.microphone?.getTracks().forEach(track => track.stop())

    if (this.recorder) {
      this.recorder.onaudioprocess = null
      this.recorder.disconnect()
    }

    this.input?.disconnect()
    this.socket?.close()
    void this.context?.close().catch(() => undefined)
    this.handlers.onClosed(reason, null)
  }
}
