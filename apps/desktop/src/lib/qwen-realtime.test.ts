import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/api/client'

import { Pcm16Encoder, QwenRealtimeSession } from './qwen-realtime'

vi.mock('@/lib/voice-playback', () => ({
  resolveSpeakStreamUrl: vi.fn(async () => 'wss://gateway.example/api/audio/speak-stream?ticket=fresh&profile=worker')
}))

class Socket {
  static OPEN = 1
  static latest: Socket
  readyState = 1
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()
  constructor(readonly url: URL) {
    Socket.latest = this
    queueMicrotask(() => this.onopen?.())
  }
  send(text: string) {
    const event = JSON.parse(text)
    this.sent.push(event)

    if (event.type === 'apex.start') {
      this.onmessage?.({ data: '{"type":"session.updated"}' })
    }
  }
}

const track = { stop: vi.fn(), enabled: true }
const recorder = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }
const source = { onended: null, buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }
const closeContext = vi.fn(async () => undefined)

class Context {
  sampleRate = 48_000
  currentTime = 0
  destination = {}
  resume = vi.fn(async () => undefined)
  close = closeContext
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  createScriptProcessor = () => recorder
  createBuffer = (_channels: number, samples: number, rate: number) => ({
    duration: samples / rate,
    getChannelData: () => new Float32Array(samples)
  })
  createBufferSource = () => source
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track]
      }))
    }
  })
})
afterEach(() => { vi.unstubAllGlobals(); setApiRequestConnection(null); setApiRequestProfile(null) })

function setup() {
  const handlers = {
    onClosed: vi.fn(),
    onDelegation: vi.fn(),
    onError: vi.fn(),
    onSpeakingChange: vi.fn(),
    onTranscript: vi.fn()
  }

  return { session: new QwenRealtimeSession(handlers), handlers }
}

describe('Qwen native realtime', () => {
  it('uses 16 kHz PCM16 clipping and retains sampling phase between microphone frames', () => {
    const encoder = new Pcm16Encoder(48_000)
    const encoded = encoder.encode(new Float32Array([-2, 0, 0, 2, 0, 0]))
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
    const pcm = new DataView(bytes.buffer)
    expect(pcm.getInt16(0, true)).toBe(-32768)
    expect(pcm.getInt16(2, true)).toBe(32767)
    const oddRate = new Pcm16Encoder(44_100)
    const lengths = Array.from({ length: 10 }, () => atob(oddRate.encode(new Float32Array(441))).length)
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(3200)
  })

  it('preserves fresh WS credentials/profile and returns one complete tool result through the current chat', async () => {
    const { session, handlers } = setup()
    await session.start()
    expect(String(Socket.latest.url)).toBe('wss://gateway.example/api/audio/qwen-realtime?ticket=fresh&profile=worker')
    session.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: '查天气' })

    const event = {
      type: 'response.function_call_arguments.done',
      name: 'apex_assistant',
      call_id: 'call-a',
      arguments: '{"request":"查询北京天气"}'
    }

    session.receive(event)
    session.receive(event)
    expect(handlers.onDelegation).toHaveBeenCalledTimes(1)
    const fragments = handlers.onDelegation.mock.calls[0][1]
    expect(fragments).toHaveLength(1)
    expect(fragments[0].text).toBe('查询北京天气')
    session.speak('call-a', '天气')
    session.speak('call-a', '服务不可用。')
    expect(Socket.latest.sent).toHaveLength(1)
    session.finishDelegation('call-a')
    expect(Socket.latest.sent[1]).toEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-a',
        output: '天气服务不可用。'
      }
    })
    expect(Socket.latest.sent[2]).toEqual({ type: 'response.create' })
    session.finishDelegation('call-a')
    expect(Socket.latest.sent).toHaveLength(3)
    session.close()
  })

  it('barge-in stops queued audio and ignores late output from the cancelled response', async () => {
    const { session } = setup()
    await session.start()
    session.receive({ type: 'response.created', response: { id: 'r-old' } })
    session.receive({ type: 'response.audio.delta', response_id: 'r-old', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    session.receive({ type: 'input_audio_buffer.speech_started' })
    expect(source.stop).toHaveBeenCalledOnce()
    expect(Socket.latest.sent.at(-1)).toEqual({ type: 'response.cancel' })
    session.receive({ type: 'response.audio.delta', response_id: 'r-old', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    session.receive({ type: 'response.done', response: { id: 'r-old' } })
    session.receive({ type: 'input_audio_buffer.speech_stopped' })
    session.receive({ type: 'response.created', response: { id: 'r-new' } })
    session.receive({ type: 'response.audio.delta', response_id: 'r-new', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledTimes(2)
    session.close()
  })

  it('serializes tool replies and recovers the committed VAD turn without closing capture', async () => {
    const { session, handlers } = setup()
    await session.start()

    const finishTool = (id: string) => {
      session.receive({ type: 'response.function_call_arguments.done', name: 'apex_assistant', call_id: id, arguments: '{"request":"查文件"}' })
      session.speak(id, '文件查询结果。')
      session.finishDelegation(id)
    }

    const creates = () => Socket.latest.sent.filter(event => event.type === 'response.create')
    session.receive({ type: 'response.created', response: { id: 'tool-turn' } })
    finishTool('call-a')
    expect(creates()).toHaveLength(0)
    session.receive({ type: 'response.done', response: { id: 'tool-turn' } })
    expect(creates()).toHaveLength(1)
    // Another tool settles before the first manual response is acknowledged.
    finishTool('call-b')
    session.receive({ type: 'response.done', response: { id: 'tool-turn' } })
    expect(creates()).toHaveLength(1)
    session.receive({ type: 'response.created', response: { id: 'manual' } })
    session.receive({ type: 'input_audio_buffer.speech_started' })
    expect(Socket.latest.sent.at(-1)).toEqual({ type: 'response.cancel' })
    session.receive({ type: 'input_audio_buffer.speech_stopped' })
    session.receive({ type: 'error', error: { message: 'Server VAD turn committed but no response was created because a manual response is already in progress.' } })
    expect(handlers.onClosed).not.toHaveBeenCalled()
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(track.stop).not.toHaveBeenCalled()
    // Cancellation receipts must still release the response slot.
    session.receive({ type: 'response.done', response_id: 'manual', response: { id: 'manual' } })
    expect(creates()).toHaveLength(2)
    session.receive({ type: 'response.created', response: { id: 'resumed' } })
    session.receive({ type: 'response.audio.delta', response_id: 'resumed', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    session.close()
  })

  it.each(['apex_voice_unavailable', 'apex_voice_failed', 'invalid_api_key', 'unknown_error'])(
    'still closes capture on %s rather than swallowing authoritative failures', async code => {
      const { session, handlers } = setup()
      await session.start()
      session.receive({ type: 'error', error: { code, message: 'Access or service unavailable' } })
      expect(handlers.onError).toHaveBeenCalledWith('Access or service unavailable', true)
      expect(handlers.onClosed).toHaveBeenCalledWith('voice_error', null)
      expect(track.stop).toHaveBeenCalledOnce()
      expect(Socket.latest.close).toHaveBeenCalledOnce()
    }
  )

  it('waits for speech and an active-response rejection to settle before retrying one reply', async () => {
    const { session, handlers } = setup()
    await session.start()
    session.receive({ type: 'input_audio_buffer.speech_started' })
    session.receive({ type: 'response.function_call_arguments.done', name: 'apex_assistant', call_id: 'call-a', arguments: '{"request":"查文件"}' })
    session.finishDelegation('call-a')
    const creates = () => Socket.latest.sent.filter(event => event.type === 'response.create')
    expect(creates()).toHaveLength(0)
    session.receive({ type: 'input_audio_buffer.speech_stopped' })
    expect(creates()).toHaveLength(0)
    session.receive({ type: 'response.created', response: { id: 'auto' } })
    session.receive({ type: 'response.done', response: { id: 'auto' } })
    expect(creates()).toHaveLength(1)
    // An upstream automatic response may win before the manual create is acked.
    session.receive({ type: 'error', error: { code: 'conversation_already_has_active_response' } })
    expect(handlers.onClosed).not.toHaveBeenCalled()
    session.receive({ type: 'response.done', response: { id: 'upstream-winner' } })
    expect(creates()).toHaveLength(2)
    session.close()
  })

  it('releases microphone, capture graph, playback and socket once; ignores late callbacks', async () => {
    const { session, handlers } = setup()
    await session.start()
    session.setMuted(true)
    expect(track.enabled).toBe(false)
    session.setMuted(false)
    expect(track.enabled).toBe(true)
    session.close()
    session.close()
    session.receive({
      type: 'response.function_call_arguments.done',
      name: 'apex_assistant',
      call_id: 'late',
      arguments: '{"request":"late"}'
    })
    expect(track.stop).toHaveBeenCalledOnce()
    expect(closeContext).toHaveBeenCalledOnce()
    expect(recorder.disconnect).toHaveBeenCalledOnce()
    expect(Socket.latest.close).toHaveBeenCalledOnce()
    expect(handlers.onClosed).toHaveBeenCalledWith('close_requested', null)
    expect(handlers.onDelegation).not.toHaveBeenCalled()
  })

  it('cleans up microphone permission granted after the user already ended the call', async () => {
    let grant: ((value: unknown) => void) | undefined
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      () =>
        new Promise(resolve => {
          grant = resolve as typeof grant
        })
    )
    const { session } = setup()
    const starting = session.start()
    session.close()
    grant?.({ getTracks: () => [track] })
    await starting
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('ends an established call and releases capture when the service sends malformed data', async () => {
    const { session, handlers } = setup()
    await session.start()
    Socket.latest.onmessage?.({ data: '{broken' })
    expect(handlers.onError).toHaveBeenCalledWith('语音服务返回了无效数据。', true)
    expect(handlers.onClosed).toHaveBeenCalledWith('invalid_response', null)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(recorder.disconnect).toHaveBeenCalledOnce()
    expect(closeContext).toHaveBeenCalledOnce()
    expect(Socket.latest.close).toHaveBeenCalledOnce()
  })
  it('ends before delegating when the active account or connection changes', async () => {
    const { session, handlers } = setup()
    await session.start()
    setApiRequestConnection('another-computer')
    setApiRequestProfile('another-user')
    session.receive({ type: 'response.function_call_arguments.done', name: 'apex_assistant', call_id: 'old-scope', arguments: '{"request":"查文件"}' })
    expect(handlers.onDelegation).not.toHaveBeenCalled()
    expect(handlers.onClosed).toHaveBeenCalledWith('account_changed', null)
    expect(track.stop).toHaveBeenCalledOnce()
  })

})
