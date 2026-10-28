import { afterEach, describe, expect, it } from 'vitest'

import { buildTurnProcess, stepChain, type TurnPart } from '@/components/assistant-ui/process/turn-process'

import { DESKTOP_ONLY_STEPS, MEMORY_FORGET_STEP, MEMORY_LIST_STEP } from './desktop-only-steps'
import { enProcess } from './en-process'
import { setRuntimeI18nLocale } from './runtime'
import { zhHantProcess } from './zh-hant-process'
import { zhProcess } from './zh-process'

const memory = (id: string, args: Record<string, unknown>): TurnPart =>
  ({ args, result: { ok: true }, toolCallId: id, toolName: 'apex_memory', type: 'tool-call' }) as TurnPart

const download = (id: string): TurnPart =>
  ({ args: {}, result: { ok: true }, toolCallId: id, toolName: 'social_download', type: 'tool-call' }) as TurnPart

afterEach(() => setRuntimeI18nLocale('en'))

describe('hc-1063 the memory ledger step in 「看过程」', () => {
  it.each([
    ['zh', '记住一条', '记好了', '忘掉一条'],
    ['zh-hant', '記住一條', '記好了', '忘掉一條'],
    ['en', 'Remember one thing', 'Noted', 'Forget one thing']
  ] as const)(
    '%s: named for remembering, and for forgetting when that is all it did',
    (locale, title, done, forget) => {
      setRuntimeI18nLocale(locale)

      const added = buildTurnProcess(
        [download('d'), memory('m', { action: 'add', content: '不露脸', kind: 'about_you' })],
        false
      )

      const step = added.steps.find(candidate => candidate.toolName === 'apex_memory')!

      expect(step.copy.title).toBe(title)
      expect(step.copy.done(step.facts)).toBe(done)
      expect(stepChain(added.steps, ' → ', total => `${total}`)).not.toMatch(/处理|處理|Working/)

      const forgot = buildTurnProcess([memory('f', { action: 'forget', ref: 'a1b2c3d4' })], false)

      expect(forgot.steps.map(candidate => candidate.copy.title)).toEqual([forget])

      // A step that added and forgot is still named for remembering.
      const both = buildTurnProcess(
        [memory('a', { action: 'add', content: 'x', kind: 'recent' }), memory('b', { action: 'forget', ref: 'r' })],
        false
      )

      expect(both.steps.map(candidate => candidate.copy.title)).toEqual([title])
    }
  )

  it('keeps Desktop-only tools out of the tables the cloud mirrors, so neither side shadows the other', () => {
    const mirrored = new Set([enProcess, zhProcess, zhHantProcess].flatMap(table => Object.keys(table.steps)))

    for (const steps of Object.values(DESKTOP_ONLY_STEPS)) {
      expect(Object.keys(steps).filter(key => mirrored.has(key))).toEqual([])
      expect(Object.keys(steps).sort()).toEqual(
        ['apex_memory', 'apex_rename', MEMORY_FORGET_STEP, MEMORY_LIST_STEP].sort()
      )
    }
  })
})

describe('hc-1082 an assistant renaming itself in 「看过程」', () => {
  const rename = { name: '小李' }

  it.each([
    ['zh', '改名字', '改好了'],
    ['zh-hant', '改名字', '改好了'],
    ['en', 'Change my name', 'Renamed']
  ] as const)('%s: named for the rename, live and reloaded through the tool_call bridge', (locale, title, done) => {
    setRuntimeI18nLocale(locale)

    const live = { args: rename, result: { ok: true }, toolCallId: 'r', toolName: 'apex_rename', type: 'tool-call' }

    const reloaded = {
      ...live,
      args: { calls: [{ arguments: rename, name: 'apex_rename' }] },
      toolName: 'tool_call'
    }

    for (const part of [live, reloaded] as TurnPart[]) {
      const [step] = buildTurnProcess([part], false).steps

      expect(step.toolName).toBe('apex_rename')
      expect(step.copy.title).toBe(title)
      expect(step.copy.done(step.facts)).toBe(done)
    }
  })
})

describe('hc-1097 looking the ledger up in 「看过程」', () => {
  const bridged = (id: string, args: Record<string, unknown>): TurnPart =>
    ({
      args: { calls: [{ arguments: args, name: 'apex_memory' }] },
      result: { ok: true },
      toolCallId: id,
      toolName: 'tool_call',
      type: 'tool-call'
    }) as TurnPart

  it.each([
    ['zh', '查一下记得什么', '查好了', '忘掉一条', '记住一条'],
    ['zh-hant', '查一下記得什麼', '查好了', '忘掉一條', '記住一條'],
    ['en', 'Check what I remember', 'Checked', 'Forget one thing', 'Remember one thing']
  ] as const)(
    '%s: a look is never named for remembering, live or reloaded',
    (locale, title, done, forget, remember) => {
      setRuntimeI18nLocale(locale)

      for (const make of [memory, bridged]) {
        const [looked] = buildTurnProcess([make('l', { action: 'list' })], false).steps

        expect(looked.toolName).toBe('apex_memory')
        expect(looked.copy.title).toBe(title)
        expect(looked.copy.done(looked.facts)).toBe(done)

        const [forgot] = buildTurnProcess([make('f', { action: 'forget', ref: 'a1b2c3d4' })], false).steps

        expect(forgot.copy.title).toBe(forget)
      }

      // A step that looked and then remembered is named for remembering.
      const both = buildTurnProcess(
        [memory('l', { action: 'list' }), memory('a', { action: 'add', content: 'x', kind: 'recent' })],
        false
      )

      expect(both.steps.map(candidate => candidate.copy.title)).toEqual([remember])
    }
  )
})
