import { describe, expect, it } from 'vitest'

import { modelVendor } from './model-vendor'

describe('modelVendor', () => {
  // Every model id currently shipped by the relay catalog plus the BYOK
  // families the picker can meet — the icon column must brand all of them.
  it.each([
    // Relay catalog (domestic vendors)
    ['deepseek-v4-flash', 'deepseek'],
    ['deepseek-v4-pro', 'deepseek'],
    ['kimi-k2.6', 'kimi'],
    ['kimi-k2.7-code', 'kimi'],
    ['glm-5.2', 'zhipu'],
    ['qwen3.7-max', 'qwen'],
    ['doubao-seed-2.1-pro', 'doubao'],
    ['doubao-seed-2.1-turbo', 'doubao'],
    ['hy3', 'hunyuan'],
    ['step-3.7-flash', 'stepfun'],
    ['mimo-v2.5-pro', 'mimo'],
    ['minimax-m3', 'minimax'],
    ['longcat-2.0', 'longcat'],
    // BYOK side
    ['claude-opus-4-5-20251101', 'claude'],
    ['claude-sonnet-4-5', 'claude'],
    ['gpt-5.5', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-2.5-pro', 'gemini'],
    ['grok-4', 'grok'],
    ['llama-4-maverick', 'meta'],
    ['mistral-large-latest', 'mistral'],
    ['abab6.5s-chat', 'minimax'],
    ['qwq-32b', 'qwen'],
    ['hunyuan-turbos-latest', 'hunyuan'],
    ['moonshot-v1-128k', 'kimi']
  ])('maps %s → %s', (modelId, vendor) => {
    expect(modelVendor(modelId)).toBe(vendor)
  })

  it('matches like every display surface: provider prefix and -APEX sentinel stripped', () => {
    expect(modelVendor('anthropic/claude-opus-4.8')).toBe('claude')
    expect(modelVendor('deepseek-v4-pro-APEX')).toBe('deepseek')
    expect(modelVendor('custom/deepseek-v4-pro-APEX')).toBe('deepseek')
  })

  it('keeps the known near-collisions apart', () => {
    // "minimax-m3" must not fall into the mimo bucket (and vice versa)…
    expect(modelVendor('mimo-v2.5-pro')).toBe('mimo')
    expect(modelVendor('minimax-m3')).toBe('minimax')
    // …"qwen3.7-max" must not read the "max" as MiniMax…
    expect(modelVendor('qwen3.7-max')).toBe('qwen')
    // …and a bare Ark "seed-…" id is Doubao, not StepFun.
    expect(modelVendor('seed-1.6-flash')).toBe('doubao')
  })

  it('returns null for unknown ids', () => {
    expect(modelVendor('my-tuned-model')).toBeNull()
    expect(modelVendor('')).toBeNull()
  })

  it('falls back to the provider hint when the id alone is anonymous', () => {
    expect(modelVendor('my-tuned-model', 'DeepSeek')).toBe('deepseek')
    expect(modelVendor('v1-32k', 'moonshot')).toBe('kimi')
    expect(modelVendor('default', 'Zhipu AI')).toBe('zhipu')
    // Unknown id + unknown hint → null (neutral tile).
    expect(modelVendor('my-tuned-model', 'custom:apex-nodes.com')).toBeNull()
  })

  it('prefers the id match over a conflicting provider hint', () => {
    // A relay/aggregator provider name must not override the model's own brand.
    expect(modelVendor('glm-5.2', 'openai')).toBe('zhipu')
  })
})
