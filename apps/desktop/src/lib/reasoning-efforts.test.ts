import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REASONING_EFFORTS,
  displayedReasoningEffort,
  nearestSupportedEffort,
  REASONING_EFFORT_LADDER,
  type ReasoningEffort,
  supportedReasoningEfforts
} from './reasoning-efforts'

describe('supportedReasoningEfforts', () => {
  // hc-598: the submenu used to offer all seven of Hermes' levels for every
  // model. These cases pin the levels each vendor's runtime profile actually
  // distinguishes — the rest were decoys.
  it.each([
    // DeepSeek passes low/medium/high through and folds the top three onto
    // `max` (plugins/model-providers/deepseek).
    ['deepseek-v4-pro', ['low', 'medium', 'high', 'max']],
    // The managed relay's `-APEX` display id routes to the same model.
    ['deepseek-v4-pro-APEX', ['low', 'medium', 'high', 'max']],
    ['deepseek/deepseek-reasoner', ['low', 'medium', 'high', 'max']],
    // GLM-5.2 has exactly two enabled levels; `high` is its floor
    // (plugins/model-providers/zai `_glm_5_2_reasoning_effort`).
    ['glm-5.2', ['high', 'max']],
    ['zhipu-glm-5.2', ['high', 'max']],
    // Moonshot only accepts low/medium/high as reasoning_effort.
    ['kimi-k2.6', ['low', 'medium', 'high']],
    // Everything with no profile evidence gets the conservative default.
    ['qwen3.7-max', ['low', 'medium', 'high']],
    ['doubao-seed-2.1-pro', ['low', 'medium', 'high']],
    ['my-tuned-model', ['low', 'medium', 'high']],
    ['', ['low', 'medium', 'high']]
  ])('offers %s the levels its vendor really has', (model, expected) => {
    expect(supportedReasoningEfforts(model)).toEqual(expected)
  })

  it('never offers a level outside Hermes own vocabulary', () => {
    // A level this table invented would be rejected by the runtime's
    // `parse_reasoning_effort`, which only accepts VALID_REASONING_EFFORTS.
    for (const model of ['deepseek-v4-pro', 'glm-5.2', 'kimi-k2.6', 'anything']) {
      for (const effort of supportedReasoningEfforts(model)) {
        expect(REASONING_EFFORT_LADDER).toContain(effort)
      }
    }
  })

  it('falls back to the provider name when the model id is anonymous', () => {
    // Same hint chain the picker's brand icons use — a BYOK row named for its
    // vendor still resolves.
    expect(supportedReasoningEfforts('default', 'Zhipu GLM')).toEqual(['high', 'max'])
    expect(supportedReasoningEfforts('default', 'Apex-nodes.com')).toEqual(DEFAULT_REASONING_EFFORTS)
  })
})

describe('nearestSupportedEffort', () => {
  const GLM: readonly ReasoningEffort[] = ['high', 'max']
  const DEEPSEEK: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max']

  it.each([
    // A level the model has is kept verbatim.
    ['high', GLM, 'high'],
    ['max', GLM, 'max'],
    ['medium', DEEPSEEK, 'medium'],
    // Over the ceiling → the ceiling, not a silent drop.
    ['ultra', DEFAULT_REASONING_EFFORTS, 'high'],
    ['xhigh', DEFAULT_REASONING_EFFORTS, 'high'],
    // Under the floor → the floor (GLM cannot think less than `high`).
    ['minimal', GLM, 'high'],
    ['low', GLM, 'high'],
    ['medium', GLM, 'high'],
    // Between two levels the stronger wins — asking for more thinking must
    // never quietly return less.
    ['xhigh', GLM, 'max'],
    ['minimal', DEEPSEEK, 'low'],
    // Case and padding are user input, not identity.
    ['  HIGH  ', GLM, 'high'],
    // Unrecognized input lands on Hermes' own default, clamped.
    ['bogus', DEEPSEEK, 'medium'],
    ['', DEEPSEEK, 'medium'],
    ['bogus', GLM, 'high']
  ])('maps %s onto the closest level the model offers', (effort, supported, expected) => {
    expect(nearestSupportedEffort(effort, supported)).toBe(expected)
  })

  it('never returns a level outside the supported set', () => {
    for (const effort of [...REASONING_EFFORT_LADDER, 'none', 'bogus', '']) {
      expect(GLM).toContain(nearestSupportedEffort(effort, GLM))
      expect(DEEPSEEK).toContain(nearestSupportedEffort(effort, DEEPSEEK))
    }
  })

  it('falls back to the conservative default when handed an empty set', () => {
    expect(nearestSupportedEffort('ultra', [])).toBe('high')
  })
})

describe('displayedReasoningEffort', () => {
  it('shows the level each model can actually honor', () => {
    expect(displayedReasoningEffort('xhigh', 'deepseek-v4-flash')).toBe('max')
    expect(displayedReasoningEffort('medium', 'glm-5.2')).toBe('high')
    expect(displayedReasoningEffort('', 'kimi-k2.6', undefined, 'high')).toBe('high')
  })

  it('preserves an explicit thinking-off state', () => {
    expect(displayedReasoningEffort('none', 'glm-5.2')).toBe('none')
  })
})
