import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import type { Locale } from '@/i18n/types'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import type { SessionMessage } from '@/types/hermes'

import { ENGINE_FAILED_TURN_NOTICE, FAILED_TURN_DISPLAY_KIND } from './failed-turn'

import { toChatMessages } from '.'

// hc-1116: the engine's failed-turn rows, as a reopened conversation shows
// them in single-thread product mode. Developer mode and single_thread off are
// pinned byte for byte by upstream-copy-identity.test.tsx.

const repoRoot = join(process.cwd(), '..', '..')

const FAILED_TURN_HISTORY: SessionMessage[] = [
  { content: '把这段素材剪成 30 秒竖屏', role: 'user', timestamp: 1 },
  { content: ENGINE_FAILED_TURN_NOTICE, display_kind: FAILED_TURN_DISPLAY_KIND, role: 'assistant', timestamp: 2 },
  { content: '再试一次', role: 'user', timestamp: 3 },
  {
    content: 'This turn did not complete. Some actions may already have run; verify their effects before resending.',
    display_kind: FAILED_TURN_DISPLAY_KIND,
    role: 'assistant',
    timestamp: 4
  }
] as SessionMessage[]

function rowTexts(history: SessionMessage[] = FAILED_TURN_HISTORY): string[] {
  return toChatMessages(history)
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.parts.map(part => (part.type === 'text' ? part.text : '')))
}

beforeEach(() => {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
})

afterEach(() => {
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
})

describe('failed-turn rows in single-thread product mode', () => {
  it.each([
    [
      'zh',
      '这条没有处理。还需要的话，再发一次。',
      '这一轮没做完，有些步骤可能已经执行了。再发之前，先看看已经做了什么。'
    ],
    [
      'zh-hant',
      '這條沒有處理。還需要的話，再發一次。',
      '這一輪沒做完，有些步驟可能已經執行了。再發之前，先看看已經做了什麼。'
    ],
    [
      'en',
      "This message wasn't processed. Send it again if you still need it.",
      "This turn didn't finish, and some steps may already have run. Check what was done before sending it again."
    ],
    [
      'ja',
      "This message wasn't processed. Send it again if you still need it.",
      "This turn didn't finish, and some steps may already have run. Check what was done before sending it again."
    ]
  ] as [Locale, string, string][])('say what happened in %s', (locale, notProcessed, partial) => {
    setRuntimeI18nLocale(locale)

    expect(rowTexts()).toEqual([notProcessed, partial])
  })

  it('reads wording a newer engine writes as "some steps may have run", the safe claim', () => {
    setRuntimeI18nLocale('zh')

    const history: SessionMessage[] = [
      { content: '做个封面', role: 'user', timestamp: 1 },
      { content: 'The turn stopped early.', display_kind: FAILED_TURN_DISPLAY_KIND, role: 'assistant', timestamp: 2 }
    ] as SessionMessage[]

    expect(rowTexts(history)).toEqual(['这一轮没做完，有些步骤可能已经执行了。再发之前，先看看已经做了什么。'])
  })

  it('leaves a reply that only quotes the notice alone (it is not typed failed_turn)', () => {
    setRuntimeI18nLocale('zh')

    const history: SessionMessage[] = [
      { content: '原文是什么？', role: 'user', timestamp: 1 },
      { content: ENGINE_FAILED_TURN_NOTICE, role: 'assistant', timestamp: 2 }
    ] as SessionMessage[]

    expect(rowTexts(history)).toEqual([ENGINE_FAILED_TURN_NOTICE])
  })

  it('keeps the engine’s row in developer mode', () => {
    setRuntimeI18nLocale('zh')
    setToolViewMode('technical')

    expect(rowTexts()).toEqual(FAILED_TURN_HISTORY.filter(m => m.role === 'assistant').map(m => m.content))
  })
})

describe('the engine twin (agent/turn_failure_copy.py)', () => {
  const engine = readFileSync(join(repoRoot, 'agent/turn_failure_copy.py'), 'utf8')

  it('still writes the "not processed" notice word for word', () => {
    expect(engine).toContain(`"${ENGINE_FAILED_TURN_NOTICE}"`)
  })

  it('still types the row failed_turn', () => {
    expect(engine).toContain(`FAILED_TURN_DISPLAY_KIND = "${FAILED_TURN_DISPLAY_KIND}"`)
  })
})
