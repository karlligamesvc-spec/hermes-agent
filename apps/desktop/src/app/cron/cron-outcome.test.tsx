import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarCronJobsSection } from '@/app/chat/sidebar/cron-jobs-section'
import { TasksView } from '@/app/tasks'
import { taskPhase } from '@/app/tasks/task-model'
import { SidebarProvider } from '@/components/ui/sidebar'
import {
  getAutomationBlueprints,
  getCronDeliveryTargets,
  getCronJobHistory,
  getCronJobRuns,
  getCronJobs,
  resumeCronJob
} from '@/hermes'
import { I18nProvider } from '@/i18n'
import { setRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'
import { setCronJobs } from '@/store/cron'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { __resetTaskNotifierState, startTaskNotifier } from '@/store/tasks'
import type { CronJob } from '@/types/hermes'

import { CronView } from '.'

vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAutomationBlueprints: vi.fn().mockResolvedValue({ blueprints: [] }),
  getCronDeliveryTargets: vi.fn().mockResolvedValue([]),
  getCronJobHistory: vi.fn(),
  getCronJobRuns: vi.fn(),
  getCronJobs: vi.fn(),
  resumeCronJob: vi.fn()
}))

const ended = (lastStatus: null | string): CronJob & { last_status: null | string } => ({
  id: 'fixture-once',
  name: '真实 once 任务',
  enabled: false,
  state: 'completed',
  schedule: { kind: 'once', display: 'once in 1m' },
  next_run_at: null,
  last_run_at: '2026-09-30T19:02:14Z',
  last_status: lastStatus,
  last_error: lastStatus === 'error' ? 'No LLM provider configured' : null,
  last_delivery_error: lastStatus === 'delivery_failed' ? 'fixture delivery rejected' : null
})

const subscriptions: Array<() => void> = []
afterEach(() => {
  for (const stop of subscriptions.splice(0)) {
    stop()
  }
})

beforeEach(() => {
  setCronJobs([])
  setRuntimeI18nLocale('zh')
  __resetTaskNotifierState()
  vi.clearAllMocks()
  vi.mocked(getAutomationBlueprints).mockResolvedValue({ blueprints: [] })
  vi.mocked(getCronDeliveryTargets).mockResolvedValue([])
  vi.mocked(getCronJobHistory).mockResolvedValue({ runs: [] })
  vi.mocked(getCronJobRuns).mockResolvedValue([])
})

function renderPage(job: CronJob, locale: Locale = 'zh') {
  vi.mocked(getCronJobs).mockResolvedValue([job])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <CronView />
      </I18nProvider>
    </QueryClientProvider>
  )
}

const outcomes: Array<[null | string, string]> = [
  ['error', '最近执行失败'],
  ['blocked_config', '配置阻止执行'],
  ['interrupted', '执行已中断'],
  ['delivery_failed', '结果交付失败'],
  ['delivery_queued', '交付结果未核实'],
  [null, '执行结果未核实'],
  ['ok', '最近执行成功']
]

describe('cron lifecycle and actual execution outcome', () => {
  it.each(outcomes)('shows outcome %s without changing the exhausted once lifecycle', async (status, label) => {
    renderPage(ended(status))
    expect(await screen.findByText('计划已结束')).toBeTruthy()
    const rowButton = await screen.findByRole('button', { name: '真实 once 任务' })
    const row = rowButton.closest('[data-panel-row]')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText(label)).toBeTruthy()
    expect(screen.getAllByText(label).length).toBeGreaterThan(1)
    expect(await screen.findByText('此处仅有会话记录，脚本任务可能没有对话。')).toBeTruthy()

    if (status !== 'ok') {
      expect(screen.queryByText('最近执行成功')).toBeNull()
    }

    if (status === 'delivery_failed') {
      expect(screen.getByText('fixture delivery rejected')).toBeTruthy()
    }

    expect(screen.queryByText('已完成')).toBeNull()
  })

  it('keeps resume tied to paused lifecycle even when the previous execution failed', async () => {
    const paused = { ...ended('blocked_config'), enabled: false, state: 'paused' }
    vi.mocked(resumeCronJob).mockResolvedValue({ ...paused, enabled: true, state: 'scheduled' })
    renderPage(paused)
    expect(await screen.findByText('已暂停')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(resumeCronJob).toHaveBeenCalledWith(paused.id))
  })

  it('keeps the explicit error state diagnostic when an older response omits last_status', async () => {
    const legacy: CronJob = { ...ended(null), state: 'error', last_error: 'fixture legacy execution error' }

    delete legacy.last_status

    renderPage(legacy)
    expect(await screen.findByText('fixture legacy execution error')).toBeTruthy()
    expect(screen.getAllByText('最近执行失败').length).toBeGreaterThan(1)
    expect(taskPhase(legacy)).toBe('failed')
  })

  it('shows failure in the real sidebar row without a fake conversation', () => {
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarCronJobsSection
            jobs={[ended('error')]}
            label="定时任务"
            onManageJob={vi.fn()}
            onOpenRun={vi.fn()}
            onToggle={vi.fn()}
            onTriggerJob={vi.fn()}
            open
          />
        </SidebarProvider>
      </I18nProvider>
    )
    expect(screen.getByText('最近执行失败')).toBeTruthy()
    expect(screen.queryByText('已完成')).toBeNull()
  })
})

const phases: Array<[null | string, string]> = [
  ['error', 'failed'],
  ['blocked_config', 'failed'],
  ['interrupted', 'failed'],
  ['delivery_failed', 'delivery-failed'],
  ['delivery_queued', 'delivery-pending'],
  ['ok', 'done'],
  [null, 'unknown'],
  ['future_status', 'unknown']
]

const notices: Array<[null | string, null | string]> = [
  ['error', 'turnError'],
  ['blocked_config', 'turnError'],
  ['interrupted', 'turnError'],
  ['delivery_failed', 'turnError'],
  ['ok', 'backgroundDone'],
  [null, null],
  ['delivery_queued', null]
]

describe('one-shot task terminal notifications', () => {
  it.each(phases)('projects %s as %s instead of assuming successful completion', (status, expected) => {
    expect(taskPhase(ended(status))).toBe(expected)
  })

  it.each(notices)('notifies the actual %s result at the running to ended transition', (status, kind) => {
    const stop = startTaskNotifier()
    subscriptions.push(stop)
    setCronJobs([{ ...ended(null), enabled: true, state: 'scheduled' }])
    setCronJobs([ended(status)])

    if (kind) {
      expect(dispatchNativeNotification).toHaveBeenCalledWith(expect.objectContaining({ kind }))
      expect(dispatchNativeNotification).toHaveBeenCalledTimes(1)

      if (status === 'delivery_failed') {
        expect(dispatchNativeNotification).toHaveBeenCalledWith(
          expect.objectContaining({ title: '任务交付失败', body: 'fixture delivery rejected' })
        )
      }
    } else {
      expect(dispatchNativeNotification).not.toHaveBeenCalled()
    }

    stop()
  })
})

describe('Tasks page preserves the result on list, detail and conversation-only history', () => {
  it.each([
    ['error', '失败'],
    ['delivery_failed', '交付失败'],
    [null, '执行结果未核实']
  ] as const)('shows the %s outcome in the ended bucket', async (status, label) => {
    setCronJobs([ended(status)])

    const { container } = render(
      <MemoryRouter initialEntries={['/tasks?task=fixture-once']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <TasksView />
        </I18nProvider>
      </MemoryRouter>
    )

    const row = await screen.findByRole('button', { name: new RegExp(`真实 once 任务.*${label}`) })
    expect(within(row).getByText(label)).toBeTruthy()
    expect(screen.getAllByText(label).length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: /^已结束\s*· 1$/ })).toBeTruthy()
    expect(await screen.findByText('暂无运行对话。')).toBeTruthy()
    expect(screen.getByText('运行对话')).toBeTruthy()
    expect(container.querySelector('[data-task-row="fixture-once"]')).not.toBeNull()
    expect(screen.queryByText('已完成')).toBeNull()

    if (status === 'delivery_failed') {
      expect(screen.getByText('fixture delivery rejected')).toBeTruthy()
    }
  })
})


const localizedFailure: Array<[Locale, string, string]> = [
  ['en', 'Latest execution failed', 'Schedule ended'],
  ['zh', '最近执行失败', '计划已结束'],
  ['zh-hant', '最近執行失敗', '計劃已結束'],
  ['ja', '直近の実行は失敗', 'スケジュール終了'],
  ['ar', 'فشل آخر تنفيذ', 'انتهى الجدول']
]

it.each(localizedFailure)('renders a real failed task in locale %s', async (locale, failureLabel, endedLabel) => {
  renderPage(ended('error'), locale)
  expect(await screen.findByText(endedLabel)).toBeTruthy()
  expect(screen.getAllByText(failureLabel).length).toBeGreaterThan(1)
  expect(screen.getByText('No LLM provider configured')).toBeTruthy()
})
