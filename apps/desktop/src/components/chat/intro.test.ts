import { afterEach, describe, expect, it, vi } from 'vitest'

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { TRANSLATIONS } from '@/i18n'
import type { Locale } from '@/i18n'

import { HOME_BRAND_ICON, sendQuickTask } from './intro'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sendQuickTask', () => {
  it('dispatches the task prompt to the main composer as a block insert', async () => {
    vi.useFakeTimers()
    const received: { mode: string; target: string; text: string }[] = []
    const off = onComposerInsertRequest(detail => received.push(detail))

    sendQuickTask('帮我分析这段聊天记录')
    // The focus bus defers dispatch to a macrotask so click handlers settle first.
    vi.runAllTimers()

    expect(received).toEqual([{ mode: 'block', target: 'main', text: '帮我分析这段聊天记录' }])
    off()
  })

  it('drops blank prompts instead of dispatching an empty insert', () => {
    vi.useFakeTimers()
    const received: unknown[] = []
    const off = onComposerInsertRequest(detail => received.push(detail))

    sendQuickTask('   ')
    vi.runAllTimers()

    expect(received).toHaveLength(0)
    off()
  })
})

describe('home quick-task copy contract', () => {
  // Names the home screen renders through <Codicon name=…>. A typo'd name paints
  // an empty glyph with no type error, so pin the set the icons must stay within.
  const KNOWN_ICONS = new Set(['comment-discussion', 'files', 'list-tree', 'checklist'])
  const EXPECTED_TASK_IDS = ['analyze-chat', 'organize-doc', 'break-down-request', 'follow-up-plan']
  const locales = Object.keys(TRANSLATIONS) as Locale[]

  it('uses a brand icon that ships in public/', () => {
    expect(HOME_BRAND_ICON).toBe('apple-touch-icon.png')
  })

  it.each(locales)('%s exposes the four business quick tasks with valid icons + prompts', locale => {
    const home = TRANSLATIONS[locale].home

    expect(home.quickTasks.map(task => task.id)).toEqual(EXPECTED_TASK_IDS)

    for (const task of home.quickTasks) {
      expect(KNOWN_ICONS.has(task.icon)).toBe(true)
      expect(task.label.trim().length).toBeGreaterThan(0)
      expect(task.prompt.trim().length).toBeGreaterThan(0)
    }

    expect(home.title.trim().length).toBeGreaterThan(0)
    expect(home.subtitle.trim().length).toBeGreaterThan(0)
  })

  it('keeps developer jargon off the Chinese home screen', () => {
    const home = TRANSLATIONS.zh.home

    const surface = [
      home.wordmark,
      home.engineBacking,
      home.title,
      home.subtitle,
      home.quickTasksLabel,
      ...home.quickTasks.flatMap(task => [task.label, task.prompt])
    ]
      .join(' ')
      .toLowerCase()

    for (const banned of ['traceback', 'repo', 'commit', 'branch', 'file path', 'bug']) {
      expect(surface).not.toContain(banned)
    }
  })
})
