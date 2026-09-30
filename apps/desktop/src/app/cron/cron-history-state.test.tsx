import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCronJobHistory, getCronJobs } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { setCronJobs } from '@/store/cron'

import { CronView } from '.'

vi.mock('@/hermes', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>

  return {
    ...actual,
    getAutomationBlueprints: vi.fn().mockResolvedValue([]),
    getCronDeliveryTargets: vi.fn().mockResolvedValue([]),
    getCronJobHistory: vi.fn(),
    getCronJobs: vi.fn()
  }
})

function renderCronView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <I18nProvider configClient={null} initialLocale="zh">
        <CronView />
      </I18nProvider>
    </QueryClientProvider>
  )
}

const job = (id: string) => ({ enabled: true, id, name: `任务 ${id}`, schedule_display: '每天 09:00' })

describe('CronView read failures', () => {
  beforeEach(() => {
    setCronJobs([])
    vi.mocked(getCronJobs).mockReset()
    vi.mocked(getCronJobHistory).mockReset()
  })

  it('shows a recoverable list error instead of claiming no scheduled jobs', async () => {
    vi.mocked(getCronJobs).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
    renderCronView()

    expect(await screen.findByRole('heading', { name: '加载定时任务失败' })).toBeTruthy()
    expect(screen.queryByText('暂无排程任务')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('暂无排程任务')).toBeTruthy()
  })

  it('keeps existing jobs visible with an error when a later list refresh fails', async () => {
    setCronJobs([job('a')])
    vi.mocked(getCronJobs).mockRejectedValue(new Error('offline'))
    vi.mocked(getCronJobHistory).mockResolvedValue({ runs: [], executions: [] })
    renderCronView()

    expect(await screen.findByText('offline')).toBeTruthy()
    expect(screen.getAllByText('任务 a').length).toBeGreaterThan(0)
    expect(screen.queryByText('暂无排程任务')).toBeNull()
  })

  it('shows a recoverable run-history error, then the real run on retry', async () => {
    vi.mocked(getCronJobs).mockResolvedValue([job('a')])
    vi.mocked(getCronJobHistory)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ runs: [{ id: 'cron_a_1', title: '真实运行' }], executions: [] } as never)
    renderCronView()

    expect(await screen.findByText('加载运行记录失败')).toBeTruthy()
    expect(screen.queryByText('尚无运行')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: /真实运行/ })).toBeTruthy()
    expect(screen.queryByText('加载运行记录失败')).toBeNull()
  })

  it('does not show the previous job run while the next job is loading', async () => {
    let resolveSecond: (runs: unknown) => void = () => {}

    const second = new Promise<unknown>(resolve => {
      resolveSecond = resolve
    })

    vi.mocked(getCronJobs).mockResolvedValue([job('a'), job('b')])
    vi.mocked(getCronJobHistory).mockImplementation(id =>
      id === 'a' ? Promise.resolve({ runs: [{ id: 'cron_a_1', title: 'A 的运行' }] } as never) : (second as never)
    )
    renderCronView()

    expect(await screen.findByRole('button', { name: /A 的运行/ })).toBeTruthy()
    fireEvent.click(screen.getByText('任务 b'))

    expect(screen.queryByText('A 的运行')).toBeNull()
    expect(screen.queryByText('尚无运行')).toBeNull()

    resolveSecond({ runs: [{ id: 'cron_b_1', title: 'B 的运行' }] })
    await waitFor(() => expect(screen.getByRole('button', { name: /B 的运行/ })).toBeTruthy())
  })

  it('shows script execution outcomes without inventing navigable conversations', async () => {
    vi.mocked(getCronJobs).mockResolvedValue([job('script')])
    vi.mocked(getCronJobHistory).mockResolvedValue({
      runs: [],
      executions: ['completed', 'failed', 'unknown'].map((status, index) => ({
        id: `execution-${index}`, status, claimed_at: '2026-09-29T12:00:00Z',
        started_at: '2026-09-29T12:00:01Z', finished_at: '2026-09-29T12:00:02Z'
      }))
    } as never)
    const { container } = renderCronView()

    expect(await screen.findByText('结果未知')).toBeTruthy()
    expect(screen.getByText('执行失败')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.queryByText('尚无运行')).toBeNull()
    expect(screen.queryByText('运行对话')).toBeNull()
    expect(container.querySelector('[data-cron-executions] button')).toBeNull()
  })
})
