import { afterEach, describe, expect, it } from 'vitest'

import { buildTurnProcess, type TurnPart } from '@/components/assistant-ui/process/turn-process'

import { DESKTOP_ONLY_STEPS } from './desktop-only-steps'
import { enProcess } from './en-process'
import { setRuntimeI18nLocale } from './runtime'
import { zhHantProcess } from './zh-hant-process'
import { zhProcess } from './zh-process'

const ownVoice = (id: string, action: string): TurnPart =>
  ({
    args: { action },
    result: { success: true },
    toolCallId: id,
    toolName: 'own_voice',
    type: 'tool-call'
  }) as TurnPart

afterEach(() => setRuntimeI18nLocale('en'))

describe('hc-1297 the own-voice step in 「看过程」', () => {
  it.each([
    ['zh', '处理你的声音', '处理好了'],
    ['zh-hant', '處理你的聲音', '處理好了'],
    ['en', 'Your own voice', 'Done']
  ] as const)('%s: named for the user’s voice, never the unnamed step', (locale, title, done) => {
    setRuntimeI18nLocale(locale)

    const turn = buildTurnProcess([ownVoice('s', 'status')], false)

    expect(turn.steps.map(step => step.copy.title)).toEqual([title])
    expect(turn.steps[0]!.copy.done(turn.steps[0]!.facts)).toBe(done)
  })

  it('sits in the tables the cloud mirrors: the hosted assistant runs the same tool', () => {
    for (const table of [enProcess, zhProcess, zhHantProcess]) {
      expect(Object.keys(table.steps)).toContain('own_voice')
    }

    for (const steps of Object.values(DESKTOP_ONLY_STEPS)) {
      expect(Object.keys(steps)).not.toContain('own_voice')
    }
  })
})
