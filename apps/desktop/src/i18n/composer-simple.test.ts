import { describe, expect, it } from 'vitest'

import { englishWords } from '@/test/zh-copy'

import { TRANSLATIONS } from './catalog'
import { COMPOSER_SIMPLE_COPY } from './composer-simple'
import type { Locale } from './types'

const CHINESE: Locale[] = ['zh', 'zh-hant']

/** Every string a locale's object can show, functions called with Chinese
 *  stand-ins so only the copy itself can produce a Latin word. */
function leaves(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') {
    return [[path, node]]
  }

  if (typeof node === 'function') {
    return [[path, String((node as (value: string) => string)('示例'))]]
  }

  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => leaves(value, `${path}.${key}`))
}

// The old catalog keys the simple composer still shows: the 高级 rows, the voice
// items, the "+" generation rows, the scenario picker, the Start workflow row.
// A key zh lacks falls back to English without a sound, so each is rendered.
const REUSED = [
  'composer.approvalMode',
  'composer.capabilities.connectors',
  'composer.capabilities.connectorsHint',
  'composer.capabilities.enabledLabel',
  'composer.capabilities.generateImage',
  'composer.capabilities.generateLabel',
  'composer.capabilities.generateVideo',
  'composer.capabilities.unused',
  'composer.message',
  'composer.send',
  'composer.speakReplies',
  'composer.startVoice',
  'composer.stop',
  'composer.stopDictation',
  'composer.stopSpeakingReplies',
  'composer.tipPost',
  'composer.tipPre',
  'composer.transcribingDictation',
  'composer.voiceControls',
  'composer.voiceDictation',
  'scenarios.comingSoon',
  'scenarios.noMatches',
  'scenarios.searchPlaceholder',
  'businessWorkspace.goalLauncher.confirmationTemplate',
  'businessWorkspace.projects.chooseWorkflow'
]

function at(tree: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree)
}

describe.each(CHINESE)('the %s simple-composer copy', locale => {
  it('has no English word, its own or one borrowed from en', () => {
    const copy = COMPOSER_SIMPLE_COPY[locale]

    const leaks = leaves(copy)
      .map(([path, text]) => [path, englishWords(text)] as const)
      .filter(([, words]) => words.length > 0)

    expect(leaks).toEqual([])
    expect(copy).not.toBe(COMPOSER_SIMPLE_COPY.en)
  })

  it('reads every old key the simple composer reuses in Chinese', () => {
    const leaks = REUSED.flatMap(path => leaves(at(TRANSLATIONS[locale], path), path))
      .map(([path, text]) => [path, englishWords(text)] as const)
      .filter(([, words]) => words.length > 0)

    expect(leaks).toEqual([])
  })

  it('keeps the voice activation names on the APEX identity', () => {
    const copy = COMPOSER_SIMPLE_COPY[locale]

    for (const label of [copy.wakeWordListening, copy.wakeWordOff, copy.wakeWordPausedVoice]) {
      expect(label.startsWith('APEX ')).toBe(true)
      expect(label).not.toMatch(/hermes/i)
    }
  })

  it('names the five platforms in Chinese and the chips exactly as decided', () => {
    const copy = COMPOSER_SIMPLE_COPY[locale].paste

    expect(Object.keys(copy.platforms).sort()).toEqual(['bilibili', 'channels', 'douyin', 'kuaishou', 'xiaohongshu'])
    expect(englishWords(Object.values(copy.platforms).join(' '))).toEqual([])
  })
})

describe('the chip labels Kael set (2026-10-20)', () => {
  it('reads 转逐字稿 / 拆它为什么火 / 仿写成我的脚本 in zh', () => {
    expect(COMPOSER_SIMPLE_COPY.zh.paste.labels).toEqual({
      breakdown: '拆它为什么火',
      remix: '仿写成我的脚本',
      transcribe: '转逐字稿'
    })
  })
})

describe('the en voice activation names', () => {
  it('repeat en.ts word for word, so the two cannot drift', () => {
    const composer = TRANSLATIONS.en.composer

    expect(COMPOSER_SIMPLE_COPY.en.wakeWordListening).toBe(composer.wakeWordListening('hey hermes'))
    expect(COMPOSER_SIMPLE_COPY.en.wakeWordOff).toBe(composer.wakeWordOff('hey hermes'))
    expect(COMPOSER_SIMPLE_COPY.en.wakeWordPausedVoice).toBe(composer.wakeWordPausedVoice('hey hermes'))
  })
})
