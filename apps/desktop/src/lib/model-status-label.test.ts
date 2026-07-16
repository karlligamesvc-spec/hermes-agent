import { describe, expect, it } from 'vitest'

import {
  currentPickerSelection,
  displayModelName,
  formatModelStatusLabel,
  managedModelDisplayName,
  modelDisplayParts,
  reasoningEffortLabel
} from './model-status-label'

describe('model-status-label', () => {
  it('maps the managed relay model to its APEX display label', () => {
    expect(managedModelDisplayName('deepseek-v4-pro')).toBe('deepseek-v4-pro-APEX')
    // Provider-prefixed managed id still maps (modelBaseId strips the prefix).
    expect(managedModelDisplayName('custom/deepseek-v4-pro')).toBe('deepseek-v4-pro-APEX')
    // Non-managed ids pass through unchanged.
    expect(managedModelDisplayName('openai/gpt-5.5')).toBe('openai/gpt-5.5')
    expect(managedModelDisplayName('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(managedModelDisplayName('')).toBe('')
  })

  it('formats display names consistently', () => {
    expect(displayModelName('anthropic/claude-opus-4.8-fast')).toBe('Opus 4.8')
    expect(displayModelName('openai/gpt-5.5-fast')).toBe('GPT-5.5')
    expect(displayModelName('deepseek/deepseek-v4-pro-thinking')).toBe('DeepSeek V4 Pro')
    expect(displayModelName('openai/gpt-5.5')).toBe('GPT-5.5')
  })

  it('keeps acronym brand names uppercase instead of title-casing them', () => {
    expect(displayModelName('glm-5.2')).toBe('GLM 5.2')
    expect(displayModelName('custom/glm-5.2')).toBe('GLM 5.2')
    // Official brand casing, not plain title-case ("Deepseek").
    expect(displayModelName('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
  })

  // hc-512: the managed `-APEX` sentinel suffix is a brand marker, split into
  // the tag slot by the ONE shared splitter — so the composer pill and every
  // picker row render the identical name for the same id.
  it('splits the managed -APEX sentinel into name + APEX tag', () => {
    expect(modelDisplayParts('deepseek-v4-pro-APEX')).toEqual({ name: 'DeepSeek V4 Pro', tag: 'APEX' })
    expect(modelDisplayParts('custom/deepseek-v4-pro-APEX')).toEqual({ name: 'DeepSeek V4 Pro', tag: 'APEX' })
    // Bare routed id → same NAME (no tag): one display for one route.
    expect(modelDisplayParts('deepseek-v4-pro')).toEqual({ name: 'DeepSeek V4 Pro', tag: '' })
  })

  it('renders the sentinel and the bare routed id under the same pill label', () => {
    expect(formatModelStatusLabel('deepseek-v4-pro-APEX', { reasoningEffort: 'high' })).toBe(
      'DeepSeek V4 Pro · High'
    )
    expect(formatModelStatusLabel('deepseek-v4-pro', { reasoningEffort: 'high' })).toBe('DeepSeek V4 Pro · High')
  })

  it('strips trailing date-pin snapshots from the display name', () => {
    expect(displayModelName('claude-opus-4-5-20251101')).toBe('Opus 4 5')
    expect(displayModelName('anthropic/claude-haiku-4-5-20251001')).toBe('Haiku 4 5')
  })

  // hc-521 (A-11): Ark ids (Doubao) pin a 6-digit YYMMDD date and encode the
  // semantic version with hyphens because the Ark id grammar forbids dots —
  // `doubao-seed-2-1-pro-260628` is "Seed 2.1", not "Seed 2 1 260628". The
  // model id itself must stay dated (Ark 404s on the bare id); only the
  // DISPLAY name is normalized.
  it.each([
    ['doubao-seed-2-1-pro-260628', 'Doubao Seed 2.1 Pro'],
    ['doubao-seed-2-1-turbo-260628', 'Doubao Seed 2.1 Turbo'],
    ['custom/doubao-seed-2-1-pro-260628', 'Doubao Seed 2.1 Pro']
  ])('normalizes the Doubao Ark id %s to %s', (model, expected) => {
    expect(displayModelName(model)).toBe(expected)
  })

  it('strips a 6-digit Ark date-pin the same way as an 8-digit one', () => {
    expect(displayModelName('doubao-seed-2-1-pro-260628')).toBe('Doubao Seed 2.1 Pro')
    // 8-digit pins (Anthropic-style) must still strip — the widened regex
    // must not regress the wider width it already handled.
    expect(displayModelName('claude-opus-4-5-20251101')).toBe('Opus 4 5')
  })

  it('chains consecutive digit-hyphen version segments into dots, not just one pair', () => {
    // No shipped id has 3+ chained numeric segments today, but the lookahead
    // regex must not stop after the first pair (a naive `(\d)-(\d)` consumes
    // the second digit, so it can't also start the next match) — guard the
    // technique directly so a future `…-3-0-1-…` id renders "3.0.1".
    expect(displayModelName('doubao-seed-3-0-1-pro-260628')).toBe('Doubao Seed 3.0.1 Pro')
  })

  // hc-521: adjacent brand-name branches in prettifyBase() must render
  // byte-for-byte the same after the Ark fix — these ids have no digit-hyphen
  // or 6/8-digit date-pin suffix, so neither regex change should touch them.
  it.each([
    ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
    ['glm-5.2', 'GLM 5.2'],
    ['kimi-k2.6', 'Kimi K2.6'],
    ['kimi-k2.7-code', 'Kimi K2.7 Code'],
    ['qwen3.7-max', 'Qwen3.7 Max'],
    ['step-3.7-flash', 'Step 3.7 Flash'],
    ['hy3', 'Hy3']
  ])('leaves the existing display name for %s unchanged (%s)', (model, expected) => {
    expect(displayModelName(model)).toBe(expected)
  })

  it('maps reasoning effort to compact labels', () => {
    expect(reasoningEffortLabel('high')).toBe('High')
    expect(reasoningEffortLabel('xhigh')).toBe('Max')
    expect(reasoningEffortLabel('')).toBe('')
  })

  it('appends fast + effort session state to the status label', () => {
    expect(formatModelStatusLabel('openai/gpt-5.5', { fastMode: true, reasoningEffort: 'high' })).toBe(
      'GPT-5.5 · Fast High'
    )
  })

  it('always surfaces the effort (default medium) so the level is visible', () => {
    expect(formatModelStatusLabel('openai/gpt-5.5', { reasoningEffort: 'medium' })).toBe('GPT-5.5 · Med')
    expect(formatModelStatusLabel('openai/gpt-5.5')).toBe('GPT-5.5 · Med')
  })

  it('returns just the placeholder name when there is no model', () => {
    expect(formatModelStatusLabel('')).toBe('No model')
  })

  describe('currentPickerSelection', () => {
    const store = { model: 'opus', provider: 'anthropic' }
    const options = { model: 'hermes-4', provider: 'nous' }

    it('prefers the sticky composer pick over the profile default pre-session', () => {
      expect(currentPickerSelection(false, store, options)).toEqual(store)
    })

    it('lets the live session model.options win when a session exists', () => {
      expect(currentPickerSelection(true, store, options)).toEqual(options)
    })

    it('falls back to options when the store is empty', () => {
      expect(currentPickerSelection(false, { model: '', provider: '' }, options)).toEqual(options)
    })

    it('falls back to the store while options are still loading', () => {
      expect(currentPickerSelection(true, store, undefined)).toEqual(store)
    })
  })
})
