import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCronJobRuns, getCronJobs } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { setCronJobs } from '@/store/cron'

import { CronView } from '.'

vi.mock('@/hermes', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>

  return {
    ...actual,
    getAutomationBlueprints: vi.fn().mockResolvedValue([]),
    getCronDeliveryTargets: vi.fn().mockResolvedValue([]),
    getCronJobRuns: vi.fn(),
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
    vi.mocked(getCronJobRuns).mockReset()
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
    vi.mocked(getCronJobRuns).mockResolvedValue([])
    renderCronView()

    expect(await screen.findByText('offline')).toBeTruthy()
    expect(screen.getAllByText('任务 a').length).toBeGreaterThan(0)
    expect(screen.queryByText('暂无排程任务')).toBeNull()
  })

  it('shows a recoverable run-history error, then the real run on retry', async () => {
    vi.mocked(getCronJobs).mockResolvedValue([job('a')])
    vi.mocked(getCronJobRuns)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ id: 'cron_a_1', title: '真实运行' }] as never)
    renderCronView()

    expect(await screen.findByText('加载运行记录失败')).toBeTruthy()
    expect(screen.queryByText('尚无运行')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: /真实运行/ })).toBeTruthy()
    expect(screen.queryByText('加载运行记录失败')).toBeNull()
  })

  it('does not show the previous job run while the next job is loading', async () => {
    let resolveSecond: (runs: unknown[]) => void = () => {}
    const second = new Promise<unknown[]>(resolve => {
      resolveSecond = resolve
    })
    vi.mocked(getCronJobs).mockResolvedValue([job('a'), job('b')])
    vi.mocked(getCronJobRuns).mockImplementation(id =>
      id === 'a' ? Promise.resolve([{ id: 'cron_a_1', title: 'A 的运行' }] as never) : (second as never)
    )
    renderCronView()

    expect(await screen.findByRole('button', { name: /A 的运行/ })).toBeTruthy()
    fireEvent.click(screen.getByText('任务 b'))

    expect(screen.queryByText('A 的运行')).toBeNull()
    expect(screen.queryByText('尚无运行')).toBeNull()

    resolveSecond([{ id: 'cron_b_1', title: 'B 的运行' }])
    await waitFor(() => expect(screen.getByRole('button', { name: /B 的运行/ })).toBeTruthy())
  })
})
