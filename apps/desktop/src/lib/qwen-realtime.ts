import { getApiRequestConnection, getApiRequestProfile } from '@/api/client'
import type { LiveHistoryMessage, LiveTranscriptFragment, VoiceLiveHandlers } from '@/lib/voice-live'
import { resolveSpeakStreamUrl } from '@/lib/voice-playback'

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
  delta?: string
  transcript?: string
  name?: string
  call_id?: string
  arguments?: string
  error?: { message?: string; code?: string }
}

/** Function calling uses the current chat's existing Hermes turn/approval loop. */
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
  private responseId: string | null = null
  private readonly cancelledResponses = new Set<string>()
  private readonly delegatedCalls = new Set<string>()
  private ready = false
  private reply = ''
  private callId: string | null = null
  private transcript: LiveTranscriptFragment[] = []
  private nextTurn = 0

  constructor(private readonly handlers: VoiceLiveHandlers) {}

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
              this.ready = true
              finish()
            }

            if (event.type === 'error' && !this.ready) {
              finish(new Error(event.error?.message ?? '千问实时语音暂不可用。'))
            }

            this.receive(event)
          } catch {
            finish(new Error('语音服务返回了无效数据。'))
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

      this.recorder.onaudioprocess = event => {
        if (!this.muted) {
          this.send({ type: 'input_audio_buffer.append', audio: encoder.encode(event.inputBuffer.getChannelData(0)) })
        }
      }

      this.input.connect(this.recorder)
      this.recorder.connect(this.context.destination)
    } catch (error) {
      this.close()
      throw error
    }
  }

  receive(event: QwenEvent): void {
    if (this.closed) {
      return
    }

    if (!this.scopeMatches()) {
      this.close('account_changed')

      return
    }

    if (event.type === 'error') {
      if (event.error?.code === 'response_cancel_not_active') {
        return
      }

      this.handlers.onError(event.error?.message ?? '千问实时语音暂不可用。', true)
      this.close('voice_error')

      return
    }

    if (event.response_id && this.cancelledResponses.has(event.response_id)) {
      return
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      this.stopAudio()

      if (this.responding) {
        if (this.responseId) {
          this.cancelledResponses.add(this.responseId)
        }

        this.send({ type: 'response.cancel' })
      }

      return
    }

    if (event.type === 'response.created' || event.type === 'response.done') {
      if (event.type === 'response.done' && event.response?.id !== this.responseId) {
        return
      }

      this.responding = event.type === 'response.created'

      if (this.responding) {
        this.responseId = event.response?.id ?? null
      }

      return
    }

    if (event.type === 'response.audio.delta' && event.delta) {
      this.play(event.delta)

      return
    }

    const role =
      event.type === 'conversation.item.input_audio_transcription.completed'
        ? 'user'
        : event.type === 'response.audio_transcript.delta'
          ? 'assistant'
          : null

    if (role) {
      const text = role === 'user' ? event.transcript : event.delta

      if (text) {
        const fragment: LiveTranscriptFragment = { speaker: role, text, startMs: Date.now(), endMs: Date.now(),
          turnId: role === 'user' ? (event.item_id ?? `user-${++this.nextTurn}`) : (this.responseId ?? 'assistant') }

        this.transcript.push(fragment)
        this.transcript = this.transcript.slice(-80)
        this.handlers.onTranscript?.(fragment)
      }

      return
    }

    if (event.type === 'response.function_call_arguments.done' && event.name === 'apex_assistant' && event.call_id) {
      if (this.delegatedCalls.has(event.call_id)) {
        return
      }

      this.delegatedCalls.add(event.call_id)

      try {
        const args = JSON.parse(event.arguments ?? '{}') as { request?: unknown }

        if (typeof args.request !== 'string' || !args.request.trim()) {
          throw new Error('Invalid assistant request')
        }

        if (this.callId) {
          this.send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: this.callId,
              output: '用户已提出新的请求，上一个请求已中止；未确认完成。'
            }
          })
        }

        this.callId = event.call_id
        this.reply = ''
        const context = [...this.transcript]

        // Tool arguments are the complete latest intent even when ASR events lag.
        if (context.at(-1)?.speaker === 'user') {
          context.pop()
        }

        context.push({ speaker: 'user', text: args.request, startMs: Date.now(), endMs: Date.now(), turnId: event.call_id })
        this.handlers.onDelegation(event.call_id, context)
      } catch {
        this.handlers.onError('语音助手请求无法读取，请重试。', true)
        this.close()
      }
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
        type: 'function_call_output',
        call_id: delegationId,
        output: this.reply || '本次请求未返回可播报结果，请查看 APEX 对话中的状态。'
      }
    })
    this.callId = null
    this.reply = ''
    this.send({ type: 'response.create' })
  }

  instruct(_content: string): void {
    // Server VAD commits and creates the reply after 700ms of silence.
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.microphone?.getAudioTracks().forEach(track => {
      track.enabled = !muted
    })
  }

  close(reason = 'close_requested'): void {
    if (this.closed) {
      return
    }

    this.closed = true
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
