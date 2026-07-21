import { describe, expect, it } from 'vitest'

import {
  type GenLadderAction,
  genLadderCallback,
  genLadderCardFromResult,
  genLadderLocale,
  genLadderSetLanguageCallback,
  isGenLadderProtocol
} from './gen-ladder'

function action(overrides: Partial<GenLadderAction> & Pick<GenLadderAction, 'id' | 'kind'>): GenLadderAction {
  return { label: overrides.id, ...overrides }
}

describe('genLadderCardFromResult', () => {
  it('takes only `card` from the full envelope, never directive/internal', () => {
    const card = { protocol_version: 'gen-ladder/1', type: 'prompt', title: 'x' }

    const result = genLadderCardFromResult({
      ok: true,
      session_id: 's1',
      card,
      directive: { tool: 'generate_image', args: { prompt: 'secret' } },
      internal: { accounting: { attempts: 2 } }
    })

    expect(result).toEqual(card)
    // The agent-private fields must not leak into what the renderer consumes.
    expect(result).not.toHaveProperty('directive')
    expect(result).not.toHaveProperty('internal')
  })

  it('accepts a bare card object (pre-extracted)', () => {
    const card = { protocol_version: 'gen-ladder/1', type: 'entry' }

    expect(genLadderCardFromResult(card)).toEqual(card)
  })

  it('accepts a bare card recognized by `type` alone (expired card lacks protocol_version)', () => {
    const card = { type: 'expired', title: 'gone', actions: [] }

    expect(genLadderCardFromResult(card)).toEqual(card)
  })

  it('parses a JSON string envelope', () => {
    const card = { protocol_version: 'gen-ladder/1', type: 'fork' }

    expect(genLadderCardFromResult(JSON.stringify({ ok: true, card }))).toEqual(card)
  })

  it.each([[undefined], [null], [''], ['not json {'], [42], [{ ok: true }], [{ hello: 'world' }]])(
    'returns null for non-card result %o',
    input => {
      expect(genLadderCardFromResult(input)).toBeNull()
    }
  )
})

describe('isGenLadderProtocol', () => {
  it.each([
    ['gen-ladder/1', true],
    ['gen-ladder/2', true],
    ['gen-ladder/10', true],
    ['gen-ladder/', true],
    ['other/1', false],
    ['', false],
    [undefined, false],
    [1, false]
  ])('%o → %s', (version, expected) => {
    expect(isGenLadderProtocol(version)).toBe(expected)
  })
})

describe('genLadderCallback — matches the cloud state-machine action contract', () => {
  it('spend → confirm with target_stage (the priced-button spend confirmation)', () => {
    const a = action({ id: 'confirm_draft', kind: 'spend', target_stage: 'draft', price: { display: '≈¥0.40 示意', estimated: true } })

    expect(genLadderCallback(a)).toEqual({ action: 'confirm', payload: { target_stage: 'draft' } })
  })

  it('spend → confirm carries the picked model when supplied', () => {
    const a = action({ id: 'confirm_final_video', kind: 'spend', target_stage: 'final_video', model_options: ['Seedance 2.0', 'Kling V3'] })

    expect(genLadderCallback(a, { model: 'Kling V3' })).toEqual({
      action: 'confirm',
      payload: { target_stage: 'final_video', model: 'Kling V3' }
    })
  })

  it('entry select → start with entry_mode', () => {
    const a = action({ id: 'entry_image', kind: 'select', entry_mode: 'image' })

    expect(genLadderCallback(a)).toEqual({ action: 'start', payload: { entry_mode: 'image' } })
  })

  it('draft select → select with index', () => {
    const a = action({ id: 'select_draft', kind: 'select', index: 2 })

    expect(genLadderCallback(a)).toEqual({ action: 'select', payload: { index: 2 } })
  })

  it('index 0 is preserved (not dropped as falsy)', () => {
    const a = action({ id: 'select_draft', kind: 'select', index: 0 })

    expect(genLadderCallback(a)).toEqual({ action: 'select', payload: { index: 0 } })
  })

  it('confirm_sensitive → acknowledge_rights', () => {
    const a = action({ id: 'acknowledge_rights', kind: 'confirm_sensitive' })

    expect(genLadderCallback(a)).toEqual({ action: 'acknowledge_rights', payload: {} })
  })

  it('free → the action id itself; back carries its target_stage', () => {
    expect(genLadderCallback(action({ id: 'edit_prompt', kind: 'free' }))).toEqual({ action: 'edit_prompt', payload: {} })
    expect(genLadderCallback(action({ id: 'back', kind: 'free', target_stage: 'prompt' }))).toEqual({
      action: 'back',
      payload: { target_stage: 'prompt' }
    })
    expect(genLadderCallback(action({ id: 'restart', kind: 'free' }))).toEqual({ action: 'restart', payload: {} })
  })

  it('an in-flight language override rides along on any action', () => {
    const a = action({ id: 'confirm_draft', kind: 'spend', target_stage: 'draft' })

    expect(genLadderCallback(a, { language: 'en' })).toEqual({
      action: 'confirm',
      payload: { target_stage: 'draft', language: 'en' }
    })
  })
})

describe('genLadderSetLanguageCallback', () => {
  it('→ set_language with the language payload', () => {
    expect(genLadderSetLanguageCallback('ja')).toEqual({ action: 'set_language', payload: { language: 'ja' } })
  })
})

describe('genLadderLocale — protocol language → desktop locale', () => {
  it.each([
    ['zh', 'zh'],
    ['en', 'en'],
    ['ja', 'ja'],
    ['zh-TW', 'zh-hant'],
    ['ko', 'zh'],
    [undefined, 'zh']
  ] as const)('%o → %s', (language, expected) => {
    expect(genLadderLocale(language)).toBe(expected)
  })
})
