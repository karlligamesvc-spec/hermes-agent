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
