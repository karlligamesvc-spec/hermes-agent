import { describe, expect, it } from 'vitest'

import type { HermesConfigRecord } from '@/types/hermes'

import { sectionFieldEntries, voiceFieldVisible } from './helpers'

const cfg = (over: Record<string, unknown> = {}): HermesConfigRecord =>
  ({
    tts: { provider: 'edge', edge: {}, openai: {} },
    stt: { enabled: true, provider: 'local', local: {}, groq: {} },
    ...over
  }) as unknown as HermesConfigRecord

describe('voiceFieldVisible', () => {
  it('does not expose realtime engine or model fields even when legacy config contains them', () => {
    const fields = sectionFieldEntries(
      {},
      cfg({
        voice: {
          voice_chat_mode: 'gpt-live',
          qwen_realtime: { model: 'qwen-audio-3.0-realtime-plus' },
          gpt_live: { voice: 'marin', instructions: 'test' },
          auto_tts: false
        }
      })
    ).get('voice')!

    expect(fields.map(([key]) => key)).not.toContain('voice.voice_chat_mode')
    expect(fields.map(([key]) => key)).not.toContain('voice.qwen_realtime.model')
    expect(fields.map(([key]) => key).some(key => key.startsWith('voice.gpt_live.'))).toBe(false)
    expect(fields.map(([key]) => key)).toContain('voice.auto_tts')
  })
  it('always shows top-level + non-provider keys', () => {
    const config = cfg()

    for (const key of ['tts.provider', 'stt.enabled', 'stt.provider', 'voice.auto_tts', 'voice.record_key']) {
      expect(voiceFieldVisible(key, config)).toBe(true)
    }
  })

  it('shows only the selected TTS provider sub-fields', () => {
    const config = cfg()
    expect(voiceFieldVisible('tts.edge.voice', config)).toBe(true)
    expect(voiceFieldVisible('tts.openai.voice', config)).toBe(false)
    expect(voiceFieldVisible('tts.elevenlabs.voice_id', config)).toBe(false)
  })

  it('shows only the selected STT provider sub-fields', () => {
    const config = cfg()
    expect(voiceFieldVisible('stt.local.model', config)).toBe(true)
    expect(voiceFieldVisible('stt.groq.model', config)).toBe(false)
  })

  it('hides every STT provider sub-field when STT is disabled', () => {
    const config = cfg({ stt: { enabled: false, provider: 'local', local: {} } })
    expect(voiceFieldVisible('stt.local.model', config)).toBe(false)
    // ...but the enable/provider toggles themselves stay visible.
    expect(voiceFieldVisible('stt.enabled', config)).toBe(true)
    expect(voiceFieldVisible('stt.provider', config)).toBe(true)
  })

  it('tracks a provider switch', () => {
    expect(voiceFieldVisible('tts.openai.voice', cfg({ tts: { provider: 'openai', openai: {} } }))).toBe(true)
    expect(voiceFieldVisible('tts.edge.voice', cfg({ tts: { provider: 'openai', openai: {} } }))).toBe(false)
  })
})
