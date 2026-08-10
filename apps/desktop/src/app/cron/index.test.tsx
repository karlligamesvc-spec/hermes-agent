import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { setCronJobs } from '@/store/cron'

import { CronView } from '.'

vi.mock('@/hermes', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>

  return {
    ...actual,
    getAutomationBlueprints: vi.fn().mockResolvedValue([]),
    getCronDeliveryTargets: vi.fn().mockResolvedValue([]),
    getCronJobs: vi.fn().mockResolvedValue([])
  }
})

describe('CronView page identity', () => {
  beforeEach(() => setCronJobs([]))

  it('names the real durable page and lets its body own the space below the heading', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const { container } = render(
      <QueryClientProvider client={client}>
        <I18nProvider configClient={null} initialLocale="zh">
          <CronView />
        </I18nProvider>
      </QueryClientProvider>
    )

    await waitFor(() => expect(container.querySelector('[data-panel-empty]')).not.toBeNull())

    const page = screen.getByRole('region', { name: '定时任务' })
    const heading = screen.getByRole('heading', { name: '定时任务' })
    const body = container.querySelector('[data-panel-page-body]')

    expect(page.getAttribute('data-cron-surface')).toBe('page')
    expect(page.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(body?.parentElement).toBe(page)
    expect(body?.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'min-h-0', 'flex-1', 'flex-col']))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })
})
