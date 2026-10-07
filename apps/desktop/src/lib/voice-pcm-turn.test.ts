import { describe, expect, it, vi } from 'vitest'

import { VoicePcmTurn } from './voice-pcm-turn'

function setup() {
  const handlers = { start: vi.fn(), append: vi.fn(), commit: vi.fn() }
  const turn = new VoicePcmTurn(16_000, handlers)
  const frame = (level: number) => turn.feed(new Float32Array(1600).fill(level))

  return { turn, handlers, frame }
}

describe('PCM utterance boundaries', () => {
  it('keeps silence and single transients local, preserves onset and commits after a natural pause', () => {
    const { frame, handlers } = setup()
    for (let i = 0; i < 20; i++) {frame(0)}
    frame(0.1)
    frame(0)
    expect(handlers.append).not.toHaveBeenCalled()
    frame(0.1)
    frame(0.1)
    expect(handlers.start).toHaveBeenCalledTimes(1)
    expect(handlers.append.mock.calls.flatMap(([samples]) => [...samples]).filter(value => value > 0.09)).toHaveLength(4800)
    for (let i = 0; i < 14; i++) {frame(0)}
    expect(handlers.commit).not.toHaveBeenCalled()
    frame(0)
    expect(handlers.commit).toHaveBeenCalledTimes(1)
    frame(0)
    expect(handlers.commit).toHaveBeenCalledTimes(1)
  })

  it('bounds uninterrupted input, separates subsequent utterances and commits explicitly only after speech', () => {
    const { turn, frame, handlers } = setup()
    turn.finish()
    expect(handlers.commit).not.toHaveBeenCalled()
    for (let i = 0; i < 450; i++) {frame(0.1)}
    expect(handlers.commit).toHaveBeenCalledTimes(1)
    frame(0.1)
    frame(0.1)
    turn.finish()
    expect(handlers.commit).toHaveBeenCalledTimes(2)
    expect(handlers.start).toHaveBeenCalledTimes(2)
  })

  it('mute/reset discards a partial capture without submitting it', () => {
    const { turn, frame, handlers } = setup()
    frame(0.1)
    frame(0.1)
    turn.reset()
    for (let i = 0; i < 20; i++) {frame(0)}
    turn.finish()
    expect(handlers.commit).not.toHaveBeenCalled()
  })
})
