/**
 * hc-1156 on the real transcript: a 口播精剪 task reads 「量节奏 → 定剪法 →
 * 剪掉停顿和口误 → 对照检查」 in single-thread product mode, never the
 * script, its subcommands or a path. Developer mode and the switch off keep
 * the computer's generic step, as before.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { clearAllPrompts } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { trimFinishedTurn, trimRunningTurn } from '@/test/trim-turn'
import { englishWords, readableText } from '@/test/zh-copy'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

// What the fixture's commands hold and a creator should never have to read.
const MECHANISM = [
  'footage_motion',
  'APEX_PYTHON',
  'HERMES_HOME',
  '.py',
  'pacing',
  'recipe',
  'compare',
  'trim',
  '/Users',
  'terminal'
]

function renderIn(locale: Locale, messages: ThreadMessage[]) {
  setRuntimeI18nLocale(locale)

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

async function activityLine(container: HTMLElement) {
  return waitFor(() => {
    const node = container.querySelector<HTMLElement>('[data-single-thread-activity]')

    expect(node).not.toBeNull()

    return node!
  })
}

beforeEach(() => {
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  $activeSessionId.set('session-trim')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearAllPrompts()
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
  clearAllPrompts()
})

describe('a finished 口播精剪 task', () => {
  it('opens onto the four steps in plain words, nothing of the mechanism', async () => {
    const { container } = renderIn('zh', trimFinishedTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))

    const steps = await waitFor(() => {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-process-step]')]

      expect(rows.length).toBeGreaterThan(0)

      return rows
    })

    expect(steps.map(row => row.querySelector('.font-medium')?.textContent)).toEqual([
      '量节奏',
      '定剪法',
      '剪掉停顿和口误',
      '对照检查'
    ])

    const text = readableText(container.querySelector<HTMLElement>('[data-single-thread-process]')!)

    expect(englishWords(text)).toEqual([])

    for (const word of MECHANISM) {
      expect(text).not.toContain(word)
    }
  })
})

describe('while the cut runs', () => {
  it.each([
    ['zh', '正在剪掉停顿和口误…', '已看完素材，正在剪辑'],
    ['zh-hant', '正在剪掉停頓和口誤…', '已看完素材，正在剪輯'],
    ['en', 'Cutting out pauses and flubs…', 'Looked through the footage — now editing']
  ] as const)('names the step and the stage in %s', async (locale, status, stage) => {
    const { container } = renderIn(locale, trimRunningTurn())
    const line = await activityLine(container)

    expect(line.querySelector('[role="status"]')?.textContent).toContain(status)
    expect(line.querySelector('[data-single-thread-stage]')?.textContent).toBe(stage)

    for (const word of ['footage_motion', 'APEX_PYTHON', '.py', '/Users']) {
      expect(readableText(line)).not.toContain(word)
    }
  })
})

describe('outside single-thread product mode', () => {
  it.each([
    ['developer mode', () => setToolViewMode('technical')],
    ['the switch off', () => $singleThreadFlag.set(false)]
  ])('%s keeps the generic step', async (_, arrange) => {
    arrange()

    const { container } = renderIn('zh', trimRunningTurn())

    await waitFor(() => expect(container.querySelector('[data-process-block]')).not.toBeNull())

    expect(container.querySelector('[data-process-status]')?.textContent).toContain('正在电脑上处理')
    expect(container.textContent).not.toContain('剪掉停顿和口误')
    expect(container.textContent).not.toContain('量节奏')
  })
})
