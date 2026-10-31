import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import type { Locale } from '@/i18n/types'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import type { SessionMessage } from '@/types/hermes'

import { toChatMessages } from '.'

// hc-1116: the engine's timeline rows, as a reopened conversation shows them
// in single-thread product mode. Developer mode and single_thread off are
// pinned byte for byte by upstream-copy-identity.test.tsx.

const TIMELINE: SessionMessage[] = [
  { content: '换成 Pro 档', role: 'user', timestamp: 1 },
  { content: 'Model switched to deepseek-v4-pro.', display_kind: 'model_switch', role: 'assistant', timestamp: 2 },
  {
    content: '[System note: Your previous turn was interrupted mid-run. Pick it up where it stopped.]',
    display_kind: 'auto_continue',
    role: 'user',
    timestamp: 3
  },
  { content: 'Personality: creative', display_kind: 'personality_switch', role: 'assistant', timestamp: 4 },
  {
    content: '[ASYNC DELEGATION BATCH COMPLETE]\n--- ✓ TASK 1/2: 写标题  (status=completed) ---\n三个标题\n',
    display_kind: 'async_delegation_complete',
    display_metadata: { display_text: 'Completed: 写标题', task_count: 2 },
    role: 'user',
    timestamp: 5
  },
  {
    content: '[IMPORTANT: Background process proc_1 finished (exit 1).]',
    display_kind: 'process_complete',
    display_metadata: { display_text: 'Background Process Failed: ffmpeg -i in.mp4 out.mp4' },
    role: 'user',
    timestamp: 6
  }
] as SessionMessage[]

function systemRows(history: SessionMessage[] = TIMELINE) {
  return toChatMessages(history).filter(message => message.role === 'system')
}

function labels(history: SessionMessage[] = TIMELINE): string[] {
  return systemRows(history).map(message => (message.parts[0]?.type === 'text' ? message.parts[0].text : ''))
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

describe('timeline rows in single-thread product mode', () => {
  it.each([
    ['zh', ['换了模型', '接着做上次被打断的那一轮', '换了人格', '2 个后台任务结束了', '后台进程结束了']],
    ['zh-hant', ['換了模型', '接著做上次被打斷的那一輪', '換了人格', '2 個後台任務結束了', '後台程序結束了']],
    [
      'en',
      [
        'Model changed',
        'Picked up the turn that was cut off',
        'Personality changed',
        '2 background tasks ended',
        'A background process ended'
      ]
    ],
    [
      'ja',
      [
        'Model changed',
        'Picked up the turn that was cut off',
        'Personality changed',
        '2 background tasks ended',
        'A background process ended'
      ]
    ]
  ] as [Locale, string[]][])('read in %s and name no command', (locale, expected) => {
    setRuntimeI18nLocale(locale)

    expect(labels()).toEqual(expected)
    expect(labels().join(' ')).not.toMatch(/ffmpeg|Finished|Failed/)
  })

  it('say "ended" for background work, never "finished": the engine’s row may say it failed', () => {
    setRuntimeI18nLocale('zh')

    expect(labels().at(-1)).toBe('后台进程结束了')
  })

  it('count background tasks only when the engine says how many', () => {
    setRuntimeI18nLocale('en')
    const one = { ...TIMELINE[4], display_metadata: { task_count: 1 } } as SessionMessage
    const unknown = { ...TIMELINE[4], display_metadata: undefined } as SessionMessage

    expect(labels([one, unknown])).toEqual(['1 background task ended', 'Background tasks ended'])
  })

  it('keep the report under a background row as it was', () => {
    setRuntimeI18nLocale('zh')
    const product = systemRows().map(message => message.asyncResult)

    setToolViewMode('technical')

    expect(product).toEqual(systemRows().map(message => message.asyncResult))
    expect(product.filter(Boolean)).toHaveLength(2)
  })

  it('keep upstream’s labels in developer mode', () => {
    setRuntimeI18nLocale('zh')
    setToolViewMode('technical')

    expect(labels()).toEqual([
      'model changed',
      'resumed interrupted turn',
      'personality changed',
      'Completed: 写标题',
      'Background Process Failed: ffmpeg -i in.mp4 out.mp4'
    ])
  })
})
