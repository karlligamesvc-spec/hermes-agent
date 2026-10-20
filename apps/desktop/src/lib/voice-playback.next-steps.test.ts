import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startSpeechStream, stopVoicePlayback } from './voice-playback'

// 「下一步」 (apex-next/1): voice conversation speaks a reply while it streams, delta by delta,
// through the gateway speak-stream socket. The block at the end of a creator skill's reply is
// buttons in the window; none of it may reach the socket, however the deltas are cut.

vi.mock('@/lib/voice-client-direct', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  directTtsConfig: async () => null
}))

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeSocket | null = null

  binaryType = ''
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  onopen: (() => void) | null = null
  readyState = FakeSocket.OPEN
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  close() {
    this.readyState = FakeSocket.CLOSED
  }

  send(data: string) {
    this.sent.push(data)
  }
}

const REPLY =
  '给你 5 个选题：\n1. 收纳避坑\n\n<!-- apex:next\n存进选题库 | 把这 5 个选题存进我的选题库\n写成脚本 | 把第 1 个选题写成脚本\n-->'

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      getConnection: async () => ({
        authMode: 'token',
        baseUrl: 'http://127.0.0.1:5151',
        wsUrl: 'ws://127.0.0.1:5151/api/ws?token=t'
      }),
      getGatewayWsUrl: async () => ({ ok: true, wsUrl: 'ws://127.0.0.1:5151/api/ws?token=t' })
    }
  })
})

afterEach(() => {
  stopVoicePlayback()
  Reflect.deleteProperty(window, 'hermesDesktop')
  vi.unstubAllGlobals()
  FakeSocket.last = null
})

describe('streamed speech of a reply that ends with a 「下一步」 block', () => {
  it.each([1, 4, 9])('never sends the block to the speak stream (deltas of %i)', async size => {
    const session = await startSpeechStream({ source: 'voice-conversation' })

    expect(session).not.toBeNull()

    for (let index = 0; index < REPLY.length; index += size) {
      session!.append(REPLY.slice(index, index + size))
    }

    session!.finish()

    const frames = FakeSocket.last!.sent.map(data => JSON.parse(data) as { done?: boolean; text?: string })
    const spoken = frames.map(frame => frame.text ?? '').join('')

    expect(spoken.trim()).toBe('给你 5 个选题：\n1. 收纳避坑')
    expect(spoken).not.toContain('<')
    expect(frames.at(-1)).toEqual({ done: true })
  })
})
