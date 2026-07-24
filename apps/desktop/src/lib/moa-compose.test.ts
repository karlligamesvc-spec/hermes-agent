import { describe, expect, it } from 'vitest'

import type { MoaConfigResponse, MoaModelSlot } from '@/types/hermes'

import {
  AUTO_PRESET_NAME,
  buildAutoMoaConfig,
  composeAutoMoa,
  composedMemberCount,
  expandMoaPresetMembers,
  pickAggregator,
  routedModelId
} from './moa-compose'

const MANAGED = 'custom:apex-nodes.com'
const slot = (model: string, provider = MANAGED): MoaModelSlot => ({ provider, model })

describe('routedModelId', () => {
  it.each([
    ['deepseek-v4-pro', 'deepseek-v4-pro'],
    ['deepseek-v4-pro-APEX', 'deepseek-v4-pro'], // managed brand suffix stripped
    ['custom/deepseek-v4-pro-APEX', 'deepseek-v4-pro'], // provider prefix stripped
    ['GLM-5.2', 'GLM-5.2'], // case preserved (ranking lowercases separately)
    ['', '']
  ])('normalizes %s -> %s', (input, expected) => {
    expect(routedModelId(input)).toBe(expected)
  })
})

describe('pickAggregator', () => {
  it('picks the highest-ranked model regardless of directory order', () => {
    // glm (rank 3) first, qwen (rank 0) last — qwen still wins.
    const picked = pickAggregator([slot('glm-5.2'), slot('kimi-k2.6'), slot('qwen3.7-max')])
    expect(picked).toEqual(slot('qwen3.7-max'))
  })

  it('ranks the managed -APEX default by its routed id', () => {
    // deepseek-v4-pro-APEX (rank 1) beats glm-5.2 (rank 3).
    expect(pickAggregator([slot('glm-5.2'), slot('deepseek-v4-pro-APEX')])).toEqual(slot('deepseek-v4-pro-APEX'))
  })

  it('ranked models beat unranked ones', () => {
    // kimi-k2.7-code is unranked (only kimi-k2.6 is in the table); glm-5.2 wins.
    expect(pickAggregator([slot('kimi-k2.7-code'), slot('glm-5.2')])).toEqual(slot('glm-5.2'))
  })

  it('falls back to the first by directory order when all are unranked', () => {
    expect(pickAggregator([slot('kimi-k2.7-code'), slot('deepseek-v4-flash')])).toEqual(slot('kimi-k2.7-code'))
  })

  it('returns null for an empty set', () => {
    expect(pickAggregator([])).toBeNull()
  })
})

describe('composeAutoMoa', () => {
  it('returns null for 0 or 1 selected (single-model path, no MoA)', () => {
    expect(composeAutoMoa([])).toBeNull()
    expect(composeAutoMoa([slot('deepseek-v4-pro')])).toBeNull()
  })

  it('returns null when a dedupe collapses the set to one (display + routed id)', () => {
    // deepseek-v4-pro and its -APEX display are the same routed model.
    expect(composeAutoMoa([slot('deepseek-v4-pro'), slot('deepseek-v4-pro-APEX')])).toBeNull()
  })

  it('aggregator = ranked pick, references = S \\ {A} (each model runs once)', () => {
    const composed = composeAutoMoa([slot('glm-5.2'), slot('deepseek-v4-pro'), slot('qwen3.7-max')])
    expect(composed).not.toBeNull()
    expect(composed!.aggregator).toEqual(slot('qwen3.7-max'))
    // References keep directory order, aggregator removed, no duplicates.
    expect(composed!.reference_models).toEqual([slot('glm-5.2'), slot('deepseek-v4-pro')])
  })

  it('PINS fanout to user_turn (billing red line)', () => {
    const composed = composeAutoMoa([slot('glm-5.2'), slot('qwen3.7-max')])
    expect(composed!.fanout).toBe('user_turn')
  })

  it('normalizes slot ids to the routed id the relay routes on', () => {
    const composed = composeAutoMoa([slot('deepseek-v4-pro-APEX'), slot('glm-5.2')])
    // deepseek (rank 1) aggregates; both slots carry the bare routed id.
    expect(composed!.aggregator).toEqual(slot('deepseek-v4-pro'))
    expect(composed!.reference_models).toEqual([slot('glm-5.2')])
  })

  it('mixed ranked + unranked: aggregator stays in the selected set', () => {
    const composed = composeAutoMoa([slot('deepseek-v4-flash'), slot('kimi-k2.6'), slot('longcat-flash')])
    // kimi-k2.6 (rank 2) is the only ranked member → it aggregates.
    expect(composed!.aggregator).toEqual(slot('kimi-k2.6'))
    expect(composed!.reference_models).toEqual([slot('deepseek-v4-flash'), slot('longcat-flash')])
  })
})

describe('buildAutoMoaConfig', () => {
  const composed = composeAutoMoa([slot('glm-5.2'), slot('qwen3.7-max')])!

  it('pins __auto__ as default + active and writes the composed preset', () => {
    const cfg = buildAutoMoaConfig(null, composed)
    expect(cfg.default_preset).toBe(AUTO_PRESET_NAME)
    expect(cfg.active_preset).toBe(AUTO_PRESET_NAME)
    const preset = cfg.presets[AUTO_PRESET_NAME]
    expect(preset.aggregator).toEqual(slot('qwen3.7-max'))
    expect(preset.reference_models).toEqual([slot('glm-5.2')])
    expect(preset.fanout).toBe('user_turn')
    expect(preset.enabled).toBe(true)
    // Flattened compat view mirrors the active preset.
    expect(cfg.fanout).toBe('user_turn')
    expect(cfg.aggregator).toEqual(slot('qwen3.7-max'))
  })

  it('preserves existing presets (old/seed presets stay, just inactive)', () => {
    const existing = {
      presets: { 'apex-moa': { fanout: 'per_iteration' } }
    } as unknown as MoaConfigResponse

    const cfg = buildAutoMoaConfig(existing, composed)
    expect(Object.keys(cfg.presets).sort()).toEqual([AUTO_PRESET_NAME, 'apex-moa'])
    expect(cfg.default_preset).toBe(AUTO_PRESET_NAME)
  })
})

describe('composedMemberCount', () => {
  it('counts references + the aggregator', () => {
    const composed = composeAutoMoa([slot('glm-5.2'), slot('qwen3.7-max'), slot('deepseek-v4-pro')])!
    const preset = buildAutoMoaConfig(null, composed).presets[AUTO_PRESET_NAME]
    expect(composedMemberCount(preset)).toBe(3)
  })

  it('returns 0 for a missing preset', () => {
    expect(composedMemberCount(undefined)).toBe(0)
    expect(composedMemberCount(null)).toBe(0)
  })
})

describe('expandMoaPresetMembers', () => {
  const directory = ['deepseek-v4-pro-APEX', 'glm-5.2', 'qwen3.7-max', 'kimi-k2.6']

  it('expands the active preset back to its member ids, in directory order', () => {
    const composed = composeAutoMoa([slot('glm-5.2'), slot('qwen3.7-max')])!
    const moa = buildAutoMoaConfig(null, composed)
    // qwen3.7-max aggregates, glm-5.2 is the reference — directory order wins
    // regardless of which is the aggregator.
    expect(expandMoaPresetMembers(moa, AUTO_PRESET_NAME, directory)).toEqual(['glm-5.2', 'qwen3.7-max'])
  })

  it('matches the managed -APEX display id to its bare routed member', () => {
    const composed = composeAutoMoa([slot('deepseek-v4-pro'), slot('kimi-k2.6')])!
    const moa = buildAutoMoaConfig(null, composed)
    expect(expandMoaPresetMembers(moa, AUTO_PRESET_NAME, directory)).toEqual(['deepseek-v4-pro-APEX', 'kimi-k2.6'])
  })

  it('returns an empty array when the preset key is missing', () => {
    expect(expandMoaPresetMembers(null, AUTO_PRESET_NAME, directory)).toEqual([])
    expect(expandMoaPresetMembers({ presets: {} } as unknown as MoaConfigResponse, AUTO_PRESET_NAME, directory)).toEqual([])
  })
})
