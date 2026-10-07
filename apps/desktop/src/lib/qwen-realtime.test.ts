import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/api/client'

import { Pcm16Encoder, QwenRealtimeSession } from './qwen-realtime'

vi.mock('@/lib/voice-playback', () => ({
  resolveSpeakStreamUrl: vi.fn(async () => 'wss://gateway.example/api/audio/speak-stream?ticket=fresh&profile=worker')
}))

class Socket {
  static OPEN = 1
  static latest: Socket
  static manualMode = true
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
      this.onmessage?.({ data: JSON.stringify({ type: 'session.updated', apex_voice_owner: Socket.manualMode ? 'primary' : undefined, session: { id: 'provider-omits-null-fields' } }) })
    }
  }
}

const track = { stop: vi.fn(), enabled: true }
const recorder = { onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void), connect: vi.fn(), disconnect: vi.fn() }
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
  Socket.manualMode = true
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

function capture(level: number, frames = 1) {
  for (let i = 0; i < frames; i++) {
    recorder.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(level) } })
  }
}
function asr(session: QwenRealtimeSession, id: string, text: string) {
  session.receive({ type: 'input_audio_buffer.committed', item_id: id })
  session.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text })
}
function readback(session: QwenRealtimeSession, id: string, text: string) {
  session.speak(id, text)
  session.finishDelegation(id)
}
const events = (type: string) => Socket.latest.sent.filter(event => event.type === type)

describe('Qwen primary-assistant realtime transport', () => {
  it('rejects an old automatic-response engine before starting PCM capture', async () => {
    Socket.manualMode = false
    const { session, handlers } = setup()
    await expect(session.start()).rejects.toThrow('请更新 APEX AI 引擎')
    expect(events('input_audio_buffer.append')).toHaveLength(0)
    expect(handlers.onClosed).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
  })
  it('releases the microphone, graph, playback, socket and callback once on close, ignoring late malformed events', async () => {
    const { session, handlers } = setup()
    await session.start()
    Socket.latest.onmessage?.({ data: 'not valid json' })
    session.close()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith('语音服务返回了无效数据。', true)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(recorder.disconnect).toHaveBeenCalledOnce()
    expect(recorder.onaudioprocess).toBeNull()
    expect(Socket.latest.close).toHaveBeenCalledOnce()
    expect(closeContext).toHaveBeenCalledOnce()
    asr(session, 'late', '已结束的输入')
    expect(handlers.onDelegation).not.toHaveBeenCalled()
  })
  it.each(['你好呀', '空包啊', '你能不能查一下抖音的热榜', '帮我查询腾讯云资源到期情况', '那刚才那个呢？'])(
    'submits every utterance verbatim once without voice-model classification: %s', async text => {
      const { session, handlers } = setup()
      await session.start()
      expect(String(Socket.latest.url)).toBe('wss://gateway.example/api/audio/qwen-realtime?ticket=fresh&profile=worker')
      asr(session, 'actual-user', text)
      asr(session, 'actual-user', text)
      session.receive({ type: 'response.function_call_arguments.done', name: 'apex_assistant', call_id: 'rewrite', arguments: '{"request":"自行改写的任务"}' })
      expect(handlers.onDelegation).toHaveBeenCalledExactlyOnceWith('actual-user', [expect.objectContaining({ speaker: 'user', text })])
      expect(handlers.onTranscript).toHaveBeenCalledOnce()
      expect(events('response.create')).toHaveLength(0)
      expect(source.start).not.toHaveBeenCalled()
      session.close()
    }
  )
  it('commits PCM for ASR without creating a reply, then reads the actual primary result in speech order', async () => {
    const { session, handlers } = setup()
    await session.start()
    capture(0, 20)
    expect(events('input_audio_buffer.append')).toHaveLength(0)
    capture(0.1, 2)
    capture(0, 15)
    expect(events('input_audio_buffer.commit')).toHaveLength(1)
    expect(events('response.create')).toHaveLength(0)
    asr(session, 'hot-list', '查询抖音热榜')
    const result = '抖音当前热榜拿到19条，这是本次返回的样本。'
    readback(session, 'hot-list', result)
    expect(events('conversation.item.create')).toEqual([{ type: 'conversation.item.create', item: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: `APEX 主助手已返回以下待朗读正文：\n${result}` }]
    } }])
    expect(events('response.create')).toHaveLength(1)
    session.receive({ type: 'response.created', response: { id: 'result' } })
    session.receive({ type: 'response.audio_transcript.delta', response_id: 'result', delta: result })
    session.receive({ type: 'response.audio.delta', response_id: 'result', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    expect(handlers.onTranscript.mock.calls.map(([f]) => [f.speaker, f.text, f.turnOrder])).toEqual([
      ['user', '查询抖音热榜', 1], ['assistant', result, 2]
    ])
    session.close()
  })
  it('never plays or captions unsolicited inability claims or stale deltas', async () => {
    const { session, handlers } = setup()
    await session.start()
    asr(session, 'question', '查询腾讯云资源')
    session.receive({ type: 'response.created', response: { id: 'unsolicited' } })
    expect(events('response.cancel')).toHaveLength(0)
    session.receive({ type: 'response.audio_transcript.delta', response_id: 'unsolicited', delta: '无法查询。' })
    session.receive({ type: 'response.audio.delta', response_id: 'unsolicited', delta: 'AAA=' })
    expect(handlers.onTranscript).toHaveBeenCalledOnce()
    expect(source.start).not.toHaveBeenCalled()
    readback(session, 'question', '账户尚未授权，请先完成授权。')
    expect(events('response.create')).toHaveLength(0)
    session.receive({ type: 'response.done', response: { id: 'unsolicited' } })
    expect(events('response.create')).toHaveLength(1)
    session.receive({ type: 'response.created', response: { id: 'actual-result' } })
    session.receive({ type: 'response.audio.delta', response_id: 'unsolicited', delta: 'AAA=' })
    session.receive({ type: 'response.audio.delta', response_id: 'actual-result', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    session.close()
  })
  it('ignores obsolete results and serializes speech until the exact terminal receipt', async () => {
    const { session } = setup()
    await session.start()
    asr(session, 'old', '之前的问题')
    asr(session, 'new', '继续刚才的问题')
    readback(session, 'old', '过时结果')
    expect(events('response.create')).toHaveLength(0)
    readback(session, 'new', '真实结果')
    session.finishDelegation('new')
    expect(events('response.create')).toHaveLength(1)
    session.receive({ type: 'response.created', response: { id: 'reading' } })
    asr(session, 'next', '下一句')
    readback(session, 'next', '下一句结果')
    expect(events('response.create')).toHaveLength(1)
    session.receive({ type: 'response.done', response: { id: 'stale-receipt' } })
    expect(events('response.create')).toHaveLength(1)
    session.receive({ type: 'response.done', response: { id: 'reading' } })
    session.receive({ type: 'response.done', response: { id: 'reading' } })
    expect(events('response.create')).toHaveLength(2)
    session.close()
  })
  it('inserts delayed older ASR in chronological captions without re-submitting or superseding the newer request', async () => {
    const { session, handlers } = setup()
    await session.start()
    capture(0.1, 2)
    capture(0, 15)
    session.receive({ type: 'input_audio_buffer.committed', item_id: 'older' })
    capture(0.1, 2)
    capture(0, 15)
    session.receive({ type: 'input_audio_buffer.committed', item_id: 'newer' })
    session.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'newer', transcript: '新的要求' })
    session.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'older', transcript: '旧要求' })
    expect(handlers.onDelegation).toHaveBeenCalledTimes(1)
    expect(handlers.onDelegation.mock.calls[0][0]).toBe('newer')
    expect(handlers.onTranscript.mock.calls.map(([f]) => [f.text, f.turnOrder])).toEqual([['新的要求', 2], ['旧要求', 1]])
    readback(session, 'newer', '新要求的结果')
    expect(events('response.create')).toHaveLength(1)
    session.close()
  })
  it('barge-in stops playback, filters cancelled media and captures the complete interjection', async () => {
    const { session, handlers } = setup()
    await session.start()
    asr(session, 'first', '你好')
    readback(session, 'first', '你好呀')
    session.receive({ type: 'response.created', response: { id: 'r-old' } })
    session.receive({ type: 'response.audio.delta', response_id: 'r-old', delta: 'AAA=' })
    capture(0.1, 2)
    expect(source.stop).toHaveBeenCalledOnce()
    expect(events('response.cancel')).toHaveLength(0)
    session.receive({ type: 'response.audio.delta', response_id: 'r-old', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    capture(0, 15)
    asr(session, 'followup', '你查到哪一步了？')
    expect(handlers.onDelegation.mock.calls.at(-1)?.[1].at(-1)?.text).toBe('你查到哪一步了？')
    session.receive({ type: 'response.done', response: { id: 'r-old' } })
    readback(session, 'followup', '还在查询中。')
    session.receive({ type: 'response.created', response: { id: 'r-new' } })
    session.receive({ type: 'response.audio.delta', response_id: 'r-new', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledTimes(2)
    session.close()
  })
  it('does not submit a completed ASR end command after its handler closes the call', async () => {
    const { session, handlers } = setup()
    await session.start()
    handlers.onTranscript.mockImplementation(() => session.close())
    asr(session, 'end', 'OK，你关闭吧。')
    expect(handlers.onDelegation).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalledOnce()
  })
  it('suppresses a barge-in before the response acknowledgement without cancelling inference or playing late old speech', async () => {
    const { session } = setup()
    await session.start()
    asr(session, 'old', '查询热榜')
    readback(session, 'old', '旧回复')
    capture(0.1, 2)
    capture(0, 15)
    asr(session, 'next', '刚才那个继续查')
    readback(session, 'next', '新回复')
    session.receive({ type: 'response.created', response: { id: 'late-old' } })
    session.receive({ type: 'response.audio.delta', response_id: 'late-old', delta: 'AAA=' })
    expect(source.start).not.toHaveBeenCalled()
    expect(events('response.cancel')).toHaveLength(0)
    expect(events('response.create')).toHaveLength(1)
    session.receive({ type: 'response.done', response: { id: 'late-old' } })
    expect(events('response.create')).toHaveLength(2)
    session.receive({ type: 'response.created', response: { id: 'next-reply' } })
    session.receive({ type: 'response.audio.delta', response_id: 'next-reply', delta: 'AAA=' })
    expect(source.start).toHaveBeenCalledOnce()
    session.close()
  })
  it('keeps 330-second tool waits alive without user turns or inference, and tears down its timer', async () => {
    vi.useFakeTimers()
    try {
      const { session } = setup()
      await session.start()
      asr(session, 'long-tool', '查询账户资源')
      await vi.advanceTimersByTimeAsync(330_000)
      expect(events('input_audio_buffer.append')).toHaveLength(11)
      expect(events('input_audio_buffer.commit')).toHaveLength(0)
      expect(events('response.create')).toHaveLength(0)
      readback(session, 'long-tool', '这是实际查询结果。')
      expect(events('response.create')).toHaveLength(1)
      session.close()
      const count = Socket.latest.sent.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(Socket.latest.sent).toHaveLength(count)
      expect(track.stop).toHaveBeenCalledOnce()
    } finally {vi.useRealTimers()}
  })
  it('mute discards partial capture without committing it or opening another microphone', async () => {
    const { session } = setup()
    await session.start()
    capture(0.1, 2)
    session.setMuted(true)
    capture(0.1, 20)
    session.instruct('finish')
    expect(events('input_audio_buffer.commit')).toHaveLength(0)
    expect(track.enabled).toBe(false)
    session.setMuted(false)
    capture(0.1, 2)
    session.instruct('finish')
    expect(events('input_audio_buffer.commit')).toHaveLength(1)
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    session.close()
  })
  it.each([
    { code: 'response_cancel_not_active', message: 'Response already ended' },
    { code: 'invalid_value', message: 'Conversation has no active response.' }
  ])('ignores the exact late cancellation receipt: $code', async error => {
    const { session, handlers } = setup()
    await session.start()
    session.receive({ type: 'error', error })
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(track.stop).not.toHaveBeenCalled()
    session.close()
  })
  it('fails closed for malformed/billing errors with the original error instead of an inability answer', async () => {
    const { session, handlers } = setup()
    await session.start()
    session.receive({ type: 'error', error: { code: 'usage_missing', message: '实时语音用量未返回' } })
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith('实时语音用量未返回', true)
    expect(handlers.onClosed).toHaveBeenCalledExactlyOnceWith('voice_error', null)
    expect(track.stop).toHaveBeenCalledOnce()
  })
  it('stops before sending audio after an account/profile switch', async () => {
    const { session, handlers } = setup()
    await session.start()
    setApiRequestProfile('different-user')
    capture(0.1, 2)
    expect(events('input_audio_buffer.append')).toHaveLength(0)
    expect(handlers.onClosed).toHaveBeenCalledExactlyOnceWith('account_changed', null)
    expect(track.stop).toHaveBeenCalledOnce()
  })
  it('encodes clipped 16 kHz PCM16 while retaining sampling phase between frames', () => {
    const encoder = new Pcm16Encoder(48_000)
    const bytes = Uint8Array.from(atob(encoder.encode(new Float32Array([-2, 0, 0, 2, 0, 0]))), c => c.charCodeAt(0))
    expect(new DataView(bytes.buffer).getInt16(0, true)).toBe(-32768)
    expect(new DataView(bytes.buffer).getInt16(2, true)).toBe(32767)
    const oddRate = new Pcm16Encoder(44_100)
    expect(Array.from({ length: 10 }, () => atob(oddRate.encode(new Float32Array(441))).length).reduce((a, b) => a + b, 0)).toBe(3200)
  })
})
