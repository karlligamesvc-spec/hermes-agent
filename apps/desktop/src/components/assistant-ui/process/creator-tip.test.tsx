import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopCreatorTip } from '@/global'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { $creatorTipByTurn, $creatorTipsCatalog, CREATOR_TIP_DELAY_MS, resetCreatorTipsForTest } from '@/store/creator-tips'
import { $creatorTipsSeen } from '@/store/creator-tips-ledger'
import { $tipsEnabled, resetTips } from '@/store/tips'
import { englishWords, readableText } from '@/test/zh-copy'

import { CreatorTipSlot } from './creator-tip'
import { CREATOR_TIP_COPY } from './creator-tip-copy'
import type { ProcessStep, TurnPhase, TurnProcess } from './turn-process'

// hc-995: a creator tip under the process status line. It waits for the step to
// run 6 seconds, keeps to its turn, and gives way to the slow-step hint, the
// failure card and developer mode.

const SLOW_HINT = '这一步要久一点，你可以先去忙别的。'

const CATALOG: DesktopCreatorTip[] = [
  {
    id: 'hook-first-3s',
    steps: ['media_transcribe'],
    text: { en: 'The first 3 seconds decide whether people keep watching.', zh: '开头 3 秒决定完播：先给结果或冲突，别先自我介绍。' }
  },
  {
    id: 'missing-angle',
    steps: ['social_search'],
    text: { en: 'Find the angle nobody has covered.', zh: '同一个选题多看几条，找大家都没拍到的那个角度。' }
  }
]

function step(key: string, toolName: string, state: ProcessStep['state']): ProcessStep {
  return { key, state, toolName } as unknown as ProcessStep
}

function turn(phase: TurnPhase, current: null | number, steps: ProcessStep[]): TurnProcess {
  return { current, phase, steps } as unknown as TurnProcess
}

const DOWNLOADED = step('s1', 'social_download', 'done')
const TRANSCRIBING = turn('running', 1, [DOWNLOADED, step('s2', 'media_transcribe', 'running')])

let host: HTMLElement

function renderSlot(process: TurnProcess, { devMode = false, locale = 'zh' as Locale, turnKey = 'turn-1' } = {}) {
  setRuntimeI18nLocale(locale)
  const current = process.current === null ? null : process.steps[process.current]

  const result = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <CreatorTipSlot
        current={current}
        devMode={devMode}
        linkClassName="link"
        noteClassName="note"
        process={process}
        slowHint={SLOW_HINT}
        turnKey={turnKey}
      />
    </I18nProvider>
  )

  host = result.container

  return result
}

const tipRow = () => host.querySelector('[data-creator-tip]')
const slowHint = () => host.querySelector('[data-process-slow-hint]')

beforeEach(() => {
  vi.useFakeTimers()
  resetCreatorTipsForTest()
  resetTips()
  $tipsEnabled.set(true)
  $creatorTipsCatalog.set(CATALOG)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('while a step runs', () => {
  it('waits 6 seconds, then the tip takes the slow-step hint’s place', () => {
    renderSlot(TRANSCRIBING)

    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS - 1))
    expect(tipRow()).toBeNull()
    expect(slowHint()?.textContent).toBe(SLOW_HINT)

    act(() => vi.advanceTimersByTime(1))
    expect(tipRow()?.getAttribute('data-creator-tip')).toBe('hook-first-3s')
    expect(tipRow()?.getAttribute('data-state')).toBe('live')
    expect(tipRow()?.textContent).toContain('小贴士')
    expect(tipRow()?.textContent).toContain('开头 3 秒决定完播')
    expect(slowHint()).toBeNull()
    expect($creatorTipsSeen.get()).toEqual(['hook-first-3s'])
  })

  it('a quick step that ends before 6 seconds spends no tip', () => {
    const { rerender } = renderSlot(turn('running', 0, [step('s1', 'social_search', 'running')]))

    act(() => vi.advanceTimersByTime(3_000))
    rerender(
      <I18nProvider configClient={null} initialLocale="zh">
        <CreatorTipSlot
          current={null}
          devMode={false}
          linkClassName="link"
          noteClassName="note"
          process={turn('running', null, [step('s1', 'social_search', 'done')])}
          slowHint={SLOW_HINT}
          turnKey="turn-1"
        />
      </I18nProvider>
    )
    act(() => vi.advanceTimersByTime(10_000))

    expect(tipRow()).toBeNull()
    expect($creatorTipsSeen.get()).toEqual([])
  })

  it('reads clean Chinese: no English word, code name or step name', () => {
    renderSlot(TRANSCRIBING)
    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS))

    expect(englishWords(readableText(tipRow()!))).toEqual([])
  })

  it('reads the English tip on an English screen', () => {
    renderSlot(TRANSCRIBING, { locale: 'en' })
    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS))

    expect(tipRow()?.textContent).toContain('Tip')
    expect(tipRow()?.textContent).toContain('The first 3 seconds decide')
    expect(screen.getByRole('button', { name: 'Close this tip' })).toBeTruthy()
  })

  it('shows nothing in developer mode, and keeps the slow-step hint', () => {
    renderSlot(TRANSCRIBING, { devMode: true })
    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS))

    expect(tipRow()).toBeNull()
    expect(slowHint()).not.toBeNull()
    expect($creatorTipsSeen.get()).toEqual([])
  })

  it('shows nothing with tips off', () => {
    $tipsEnabled.set(false)
    renderSlot(TRANSCRIBING)
    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS))

    expect(tipRow()).toBeNull()
    expect(slowHint()).not.toBeNull()
  })
})

describe('the tip’s own controls', () => {
  it('✕ closes it in this turn and brings the slow-step hint back', () => {
    renderSlot(TRANSCRIBING)
    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS))

    fireEvent.click(screen.getByRole('button', { name: '关掉这条贴士' }))

    expect(tipRow()).toBeNull()
    expect(slowHint()?.textContent).toBe(SLOW_HINT)
    expect($creatorTipByTurn.get()['turn-1']?.dismissed).toBe(true)
  })

  it('「不再显示小贴士」 turns every tip off and says where to turn them back on', () => {
    renderSlot(TRANSCRIBING)
    act(() => vi.advanceTimersByTime(CREATOR_TIP_DELAY_MS))

    fireEvent.click(screen.getByRole('button', { name: CREATOR_TIP_COPY.zh.turnOffAll }))

    expect($tipsEnabled.get()).toBe(false)
    expect(tipRow()).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('已关掉小贴士。想再看，到 设置 › 外观 › 应用内提示 打开。')
  })
})

describe('after the step', () => {
  it('stays with its turn, quieter, once the task is done', () => {
    $creatorTipByTurn.set({ 'turn-1': { dismissed: false, tipId: 'hook-first-3s' } })
    renderSlot(turn('done', null, [DOWNLOADED, step('s2', 'media_transcribe', 'done')]))

    expect(tipRow()?.getAttribute('data-state')).toBe('settled')
    expect(slowHint()).toBeNull()
  })

  it('gives way to the failure card when the task gets stuck', () => {
    $creatorTipByTurn.set({ 'turn-1': { dismissed: false, tipId: 'hook-first-3s' } })
    renderSlot(turn('failed', null, [DOWNLOADED, step('s2', 'media_transcribe', 'failed')]))

    expect(tipRow()).toBeNull()
  })

  it('a turn that never claimed one shows nothing once done', () => {
    renderSlot(turn('done', null, [DOWNLOADED]))

    expect(tipRow()).toBeNull()
    expect(slowHint()).toBeNull()
  })
})
