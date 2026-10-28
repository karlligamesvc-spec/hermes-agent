/**
 * hc-1090 (多助手二期 R5): the usage hint on the relay confirmation card —
 * 「要多跑 N 个回合，按你的套餐额度算 · 本月已用 x%」, a reminder past 80%, no
 * relay once the allowance is used up, never an amount of money (L6).
 */
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopPlanUsage, DesktopPlanUsageResult } from '@/global'
import { I18nProvider } from '@/i18n'
import { HANDOFF_USAGE_NEAR_RATIO, handoffUsageHint } from '@/i18n/handoff-usage'
import { setRuntimeI18nLocale } from '@/i18n/runtime'
import { formatUsedPercent, SINGLE_THREAD_SIDEBAR_COPY } from '@/i18n/single-thread-sidebar'
import type { Locale } from '@/i18n/types'

import { $authState } from './auth'
import { checkHandoffUsage, useHandoffUsageHint } from './handoff-usage'
import { $planUsage } from './plan-usage'
import { setSingleThreadFlagForTest } from './single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from './single-thread-bots'
import { resetHandoffsForTest, setMultiBotHandoffFlagForTest } from './single-thread-handoff'
import { setToolViewMode } from './tool-view'

const month = (usedRatio: null | number): DesktopPlanUsage => ({ period: 'month', planName: '快速', usedRatio })
const week = (usedRatio: number): DesktopPlanUsage => ({ period: 'week', planName: '快速', usedRatio })

describe('handoffUsageHint (the card line)', () => {
  it.each<[string, number, DesktopPlanUsage | null, Locale, string]>([
    ['zh, monthly', 2, month(0.18), 'zh', '要多跑 2 个回合，按你的套餐额度算 · 本月已用 18%'],
    ['zh, weekly', 1, week(0.4), 'zh', '要多跑 1 个回合，按你的套餐额度算 · 本周已用 40%'],
    ['zh, under one percent', 3, month(0.004), 'zh', '要多跑 3 个回合，按你的套餐额度算 · 本月已用 不到 1%'],
    ['zh, unlimited plan', 2, month(null), 'zh', '要多跑 2 个回合，按你的套餐额度算'],
    ['zh, no usage line', 2, null, 'zh', '要多跑 2 个回合，按你的套餐额度算'],
    ['zh-hant, monthly', 2, month(0.18), 'zh-hant', '要多跑 2 個回合，按你的方案額度算 · 本月已用 18%'],
    ['zh-hant, weekly', 2, week(0.5), 'zh-hant', '要多跑 2 個回合，按你的方案額度算 · 本週已用 50%'],
    ['en, one turn', 1, month(0.18), 'en', 'Takes 1 more turn, counted against your plan · 18% used this month'],
    ['en, two turns weekly', 2, week(0.29), 'en', 'Takes 2 more turns, counted against your plan · 29% used this week'],
    ['en, no usage line', 2, null, 'en', 'Takes 2 more turns, counted against your plan'],
    ['ja reads en', 2, month(0.18), 'ja', 'Takes 2 more turns, counted against your plan · 18% used this month']
  ])('%s', (_label, turns, usage, locale, line) => {
    expect(handoffUsageHint(turns, usage, locale).line).toBe(line)
  })

  it('shows the percent the sidebar account row shows', () => {
    for (const ratio of [0, 0.004, 0.29, 0.805, 0.999, 1.25]) {
      const percent = formatUsedPercent(ratio, SINGLE_THREAD_SIDEBAR_COPY.zh)

      expect(handoffUsageHint(1, month(ratio), 'zh').line).toBe(
        `要多跑 1 个回合，按你的套餐额度算 · 本月已用 ${percent}`
      )
    }
  })

  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [2.7, 2]
  ])('turns %s reads as %s', (turns, shown) => {
    expect(handoffUsageHint(turns, null, 'zh').line).toBe(`要多跑 ${shown} 个回合，按你的套餐额度算`)
  })

  it.each<[string, DesktopPlanUsage | null, { level: string; start: boolean; warn: boolean; reason: boolean }]>([
    ['no usage line', null, { level: 'unknown', reason: false, start: true, warn: false }],
    ['unlimited', month(null), { level: 'unlimited', reason: false, start: true, warn: false }],
    ['nothing used', month(0), { level: 'ok', reason: false, start: true, warn: false }],
    ['exactly 80%', month(HANDOFF_USAGE_NEAR_RATIO), { level: 'ok', reason: false, start: true, warn: false }],
    ['past 80%', month(0.8001), { level: 'near', reason: false, start: true, warn: true }],
    ['99.99%', month(0.9999), { level: 'near', reason: false, start: true, warn: true }],
    ['exactly used up', month(1), { level: 'used_up', reason: true, start: false, warn: false }],
    ['over the allowance', month(1.25), { level: 'used_up', reason: true, start: false, warn: false }]
  ])('%s: start, reminder and reason', (_label, usage, expected) => {
    const hint = handoffUsageHint(2, usage, 'zh')

    expect(hint.level).toBe(expected.level)
    expect(hint.start).toBe(expected.start)
    expect(hint.warning !== null).toBe(expected.warn)
    expect(hint.reason !== null).toBe(expected.reason)
  })

  it.each<[Locale, DesktopPlanUsage, string, string]>([
    [
      'zh',
      month(0.9),
      '本月额度已用过 80%，多跑几个回合可能就用完了。',
      '本月额度已经用完，这次先不交出去：接手的助手跑不了新回合。下个月额度恢复后再试。'
    ],
    [
      'zh',
      week(0.9),
      '本周额度已用过 80%，多跑几个回合可能就用完了。',
      '本周额度已经用完，这次先不交出去：接手的助手跑不了新回合。下周额度恢复后再试。'
    ],
    [
      'zh-hant',
      month(0.9),
      '本月額度已用過 80%，多跑幾個回合可能就用完了。',
      '本月額度已經用完，這次先不交出去：接手的助手跑不了新回合。下個月額度恢復後再試。'
    ],
    [
      'en',
      month(0.9),
      'Over 80% of this month’s allowance is used. These turns may use up the rest.',
      'This month’s allowance is used up, so this won’t be handed over: the other assistant can’t run a turn now. Try again once it resets next month.'
    ]
  ])('%s reminder and refusal words', (locale, near, warning, reason) => {
    expect(handoffUsageHint(2, near, locale).warning).toBe(warning)
    expect(handoffUsageHint(2, { ...near, usedRatio: 1 }, locale).reason).toBe(reason)
  })

  it('never names an amount of money (L6)', () => {
    const usages = [null, month(null), month(0.18), month(0.9), month(1.5), week(0.9), week(1)]

    for (const locale of ['zh', 'zh-hant', 'en', 'ja', 'ar'] as const) {
      for (const usage of usages) {
        const hint = handoffUsageHint(3, usage, locale)
        const words = [hint.line, hint.warning, hint.reason].filter(Boolean).join(' ')

        expect(words).not.toMatch(/[¥￥$€]|元|块钱|塊錢|CNY|RMB|USD|yuan|cost|price|费用|費用|价格|價格/i)
      }
    }
  })
})

type PlanUsageRead = () => Promise<DesktopPlanUsageResult>

function installPlanUsage(read: PlanUsageRead | undefined): void {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { managed: read ? { planUsage: read } : {} }
}

const ROSTER = botRosterFrom(
  [
    { is_default: true, name: 'default' },
    { name: 'editor', ui_meta: { apex: { created: 1, name: '剪辑' } } }
  ],
  () => true
)

function relayOn(on: boolean): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(on)
  resetBotRosterForTest(ROSTER)
}

const zhProvider = ({ children }: { children: ReactNode }) =>
  createElement(I18nProvider, { children, configClient: null, initialLocale: 'zh' })

describe('useHandoffUsageHint / checkHandoffUsage', () => {
  beforeEach(() => {
    localStorage.clear()
    resetHandoffsForTest()
    $planUsage.set(null)
    $authState.set({
      ...$authState.get(),
      account: { ...$authState.get().account, email: 'me@example.com' },
      accountId: 'acc-1',
      status: 'signed-in'
    })
    setRuntimeI18nLocale('zh')
  })

  afterEach(() => {
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
    setRuntimeI18nLocale('en')
  })

  it('relay off: no hint and no read', async () => {
    const read = vi.fn<PlanUsageRead>(async () => ({ ok: true, usage: month(0.5) }))

    installPlanUsage(read)
    relayOn(false)

    const { result } = renderHook(() => useHandoffUsageHint(2), { wrapper: zhProvider })

    expect(result.current).toBeNull()
    expect(await checkHandoffUsage(2)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect($planUsage.get()).toBeNull()
  })

  it('relay on: reads the usage line when the card mounts and shows it', async () => {
    const read = vi.fn<PlanUsageRead>(async () => ({ ok: true, usage: month(0.85) }))

    installPlanUsage(read)
    relayOn(true)

    const { result } = renderHook(() => useHandoffUsageHint(2), { wrapper: zhProvider })

    // Before the read lands there is no number yet.
    expect(result.current?.level).toBe('unknown')
    await waitFor(() => expect(result.current?.level).toBe('near'))
    expect(result.current).toEqual({
      level: 'near',
      line: '要多跑 2 个回合，按你的套餐额度算 · 本月已用 85%',
      reason: null,
      start: true,
      warning: '本月额度已用过 80%，多跑几个回合可能就用完了。'
    })
    expect(read).toHaveBeenCalledTimes(1)
    // Kept under the key the sidebar account row reads.
    expect($planUsage.get()?.accountId).toBe('acc-1')
  })

  it('never shows another account’s usage line', () => {
    installPlanUsage(undefined)
    relayOn(true)
    $planUsage.set({ accountId: 'someone-else', usage: month(1.5) })

    const { result } = renderHook(() => useHandoffUsageHint(1), { wrapper: zhProvider })

    expect(result.current?.level).toBe('unknown')
    expect(result.current?.start).toBe(true)
  })

  it('checkHandoffUsage reads first, so a used-up allowance stops the relay', async () => {
    const read = vi.fn<PlanUsageRead>(async () => ({ ok: true, usage: month(1) }))

    installPlanUsage(read)
    relayOn(true)
    $planUsage.set({ accountId: 'acc-1', usage: month(0.1) })

    const hint = await checkHandoffUsage(2)

    expect(read).toHaveBeenCalledTimes(1)
    expect(hint?.start).toBe(false)
    expect(hint?.reason).toBe('本月额度已经用完，这次先不交出去：接手的助手跑不了新回合。下个月额度恢复后再试。')
  })

  it('a failed read keeps the last good line', async () => {
    installPlanUsage(async () => ({ message: 'FETCH_FAILED', ok: false, usage: null }))
    relayOn(true)
    $planUsage.set({ accountId: 'acc-1', usage: month(0.3) })

    expect((await checkHandoffUsage(1))?.line).toBe('要多跑 1 个回合，按你的套餐额度算 · 本月已用 30%')
  })
})
