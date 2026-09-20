import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { I18nProvider } from '@/i18n'

import type { WorkflowRunOverview } from './api/types'
import { WorkflowRunView } from './workflow-run-view'

const overview: WorkflowRunOverview = {
  deliverables: [
    {
      createdAt: '2026-08-27T10:03:00Z',
      evidenceCount: 1,
      id: 'deliverable-1',
      kind: 'report',
      openReference: null,
      reviews: [],
      status: 'ready',
      title: 'Pet market evidence report',
      updatedAt: '2026-08-27T10:03:00Z'
    }
  ],
  events: [
    {
      eventType: 'run.queued',
      happenedAt: '2026-08-27T10:00:00Z',
      id: 'event-1',
      sequence: 1
    },
    {
      eventType: 'run.waiting_review',
      happenedAt: '2026-08-27T10:03:00Z',
      id: 'event-2',
      sequence: 2
    },
    {
      eventType: 'run.cancel_requested',
      happenedAt: '2026-08-27T10:04:00Z',
      id: 'event-3',
      sequence: 3
    },
    {
      eventType: 'run.succeeded',
      happenedAt: '2026-08-27T10:05:00Z',
      id: 'event-4',
      sequence: 4
    }
  ],
  run: {
    attempt: 1,
    completedAt: null,
    createdAt: '2026-08-27T10:00:00Z',
    executorType: 'hermes',
    id: 'run-795',
    maxAttempts: 2,
    startedAt: '2026-08-27T10:00:02Z',
    status: 'waiting_review',
    triggerRef: 'Analyze the US pet market',
    updatedAt: '2026-08-27T10:03:00Z'
  },
  steps: []
}

describe('hc-795 real workflow Run view', () => {
  const cancelRun = vi.fn(async () => ({ ok: true }))
  const getRun = vi.fn(async () => ({ ok: true, overview }))
  const reviewDeliverable = vi.fn(async () => ({ ok: true }))
  const retryRunStep = vi.fn(async () => ({ ok: true }))

  beforeEach(() => {
    cancelRun.mockClear()
    getRun.mockClear()
    getRun.mockResolvedValue({ ok: true, overview })
    reviewDeliverable.mockClear()
    retryRunStep.mockClear()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        workflowDomain: {
          access: vi.fn(),
          cancelRun,
          getRun,
          retryRunStep,
          reviewDeliverable,
          startGoal: vi.fn()
        }
      }
    })
  })

  it('renders server events and deliverables, then submits review through the typed exit', async () => {
    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByRole('heading', { name: 'Workflow run' })).toBeTruthy()
    expect(globalThis.document.querySelector('[data-run-scroll-container]')).toBeTruthy()
    expect(screen.getByText('Analyze the US pet market')).toBeTruthy()
    expect(screen.getAllByText('Waiting for review')).toHaveLength(1)
    expect(screen.getByText('Pet market evidence report')).toBeTruthy()
    expect(screen.getByText(/1 evidence item/)).toBeTruthy()
    expect(screen.getByText('No stage progress to show yet')).toBeTruthy()
    expect(globalThis.document.querySelector('[data-stage-empty-state="compact"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open deliverable' }).hasAttribute('disabled')).toBe(false)

    const reviewHeading = screen.getByRole('heading', { name: 'Review required', level: 2 })
    const stageHeading = screen.getByRole('heading', { name: 'Stage progress', level: 2 })
    const approveButton = screen.getByRole('button', { name: 'Approve deliverable' })

    expect(reviewHeading.compareDocumentPosition(stageHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(approveButton.compareDocumentPosition(stageHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Execution details' }), { button: 0, ctrlKey: false })

    expect(screen.getByText('Run queued')).toBeTruthy()
    expect(screen.getByText('Added to the queue and getting ready to start.')).toBeTruthy()
    expect(screen.getByText('Attempt 1 (up to 2)')).toBeTruthy()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Progress' }), { button: 0, ctrlKey: false })

    fireEvent.click(screen.getByRole('button', { name: 'Approve deliverable' }))

    await waitFor(() =>
      expect(reviewDeliverable).toHaveBeenCalledWith({ deliverableId: 'deliverable-1', status: 'approved' })
    )
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2))
  })

  it('keeps the retryable Run error inside the shared page gutters', async () => {
    getRun.mockRejectedValueOnce(new Error('local test: Run unavailable'))

    const { container } = render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    const retry = await screen.findByRole('button', { name: 'Read again' })
    expect(container.querySelector('[data-run-error-container]')?.classList.contains(PAGE_INSET_X)).toBe(true)
    fireEvent.click(retry)
    expect(await screen.findByRole('heading', { name: 'Workflow run' })).toBeTruthy()
  })

  it('routes request-changes to Deliverable detail so a required revision note cannot be skipped', async () => {
    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
            <Route element={<div>deliverable-review-form</div>} path="deliverables/:deliverableId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('Pet market evidence report')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    expect(await screen.findByText('deliverable-review-form')).toBeTruthy()
    expect(reviewDeliverable).not.toHaveBeenCalled()
  })

  it('offers Run approval only on the final delivery package', async () => {
    getRun.mockResolvedValue({
      ok: true,
      overview: {
        ...overview,
        deliverables: [
          { ...overview.deliverables[0], id: 'source-bundle', kind: 'video_source_bundle', title: '原视频与数据' },
          {
            ...overview.deliverables[0],
            id: 'delivery-package',
            kind: 'video_delivery_package',
            title: '成片与工程包'
          }
        ],
        steps: [
          {
            attempt: 1,
            completedAt: '2026-08-27T10:03:00Z',
            createdAt: '2026-08-27T10:00:00Z',
            evidenceCount: 2,
            id: 'delivery-step',
            key: 'delivery_package',
            position: 6,
            runId: 'run-795',
            startedAt: '2026-08-27T10:02:00Z',
            status: 'succeeded',
            summary: '交付包已校验',
            title: '交付成片与工程',
            updatedAt: '2026-08-27T10:03:00Z'
          }
        ]
      }
    })

    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('1 个真实交付物等待你的决定。')).toBeTruthy()
    expect(screen.getByText('原视频与数据')).toBeTruthy()
    expect(screen.getByText('成片与工程包')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '批准交付物' })).toHaveLength(1)
  })

  it('offers cancellation only for a cancellable Run and refreshes after the mutation succeeds', async () => {
    const runningOverview = { ...overview, run: { ...overview.run, status: 'running' } }
    getRun.mockResolvedValue({ ok: true, overview: runningOverview })

    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))

    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('run-795'))
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2))
  })

  it('renders persisted stage truth and retries only the failed stage', async () => {
    const stepTitles = [
      '采集视频与数据',
      '逐字稿与关键帧',
      '镜头分析报告',
      'Brief 与可编辑工程',
      '素材生成与质检',
      '预览、修订与渲染',
      '交付成片与工程'
    ]
    const failedOverview: WorkflowRunOverview = {
      ...overview,
      deliverables: [],
      run: { ...overview.run, status: 'failed' },
      steps: stepTitles.map((title, position) => ({
        attempt: 1,
        completedAt: position === 0 ? '2026-08-27T10:01:00Z' : null,
        createdAt: '2026-08-27T10:00:00Z',
        evidenceCount: position === 0 ? 3 : 0,
        id: `step-${position}`,
        key: `step_${position}`,
        position,
        runId: 'run-795',
        startedAt: position < 2 ? '2026-08-27T10:00:02Z' : null,
        status: position === 0 ? 'succeeded' : position === 1 ? 'failed' : 'pending',
        summary: position === 0 ? '已保存原视频与互动数据' : null,
        title,
        updatedAt: '2026-08-27T10:03:00Z'
      }))
    }
    getRun.mockResolvedValue({ ok: true, overview: failedOverview })

    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('已完成 1/7 个阶段')).toBeTruthy()
    expect(screen.getByText('逐字稿与关键帧')).toBeTruthy()
    expect(screen.getByText('3 份产物凭证')).toBeTruthy()
    expect(screen.queryByText('暂时没有可展示的阶段进度')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试此阶段' }))

    await waitFor(() => expect(retryRunStep).toHaveBeenCalledWith({ runId: 'run-795', stepKey: 'step_1' }))
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2))
  })

  it('routes a Run result into its canonical Deliverable detail instead of exposing storage references', async () => {
    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
            <Route element={<div>canonical-deliverable-detail</div>} path="deliverables/:deliverableId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Open deliverable' }))

    expect(await screen.findByText('canonical-deliverable-detail')).toBeTruthy()
  })

  it('never renders raw event payloads or unsupported executor identity', async () => {
    getRun.mockResolvedValue({
      ok: true,
      overview: {
        ...overview,
        events: [
          {
            eventType: 'tool.result',
            happenedAt: '2026-08-27T10:02:00Z',
            id: 'event-sensitive',
            payload: {
              config: { apiKey: 'sk-sensitive' },
              schema: 'private-schema',
              user_id: 'tenant-user'
            },
            sequence: 3
          }
        ]
      } as unknown as WorkflowRunOverview
    })

    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Execution details' }), {
      button: 0,
      ctrlKey: false
    })

    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('APEX / Hermes used a tool. Arguments and results are hidden.')).toBeTruthy()
    expect(screen.queryByText(/sk-sensitive|private-schema|tenant-user/)).toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/deepseek/i)
  })

  it('does not expose Review actions after the Run reaches a terminal state', async () => {
    getRun.mockResolvedValue({ ok: true, overview: { ...overview, run: { ...overview.run, status: 'succeeded' } } })

    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('Pet market evidence report')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve deliverable' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull()
  })

  it('localizes canonical Run lifecycle events instead of exposing backend enum keys', async () => {
    const runningOverview = {
      ...overview,
      events: [{ ...overview.events[0], eventType: 'run.running', id: 'event-running' }]
    }

    getRun.mockResolvedValue({ ok: true, overview: runningOverview })

    render(
      <MemoryRouter initialEntries={['/workflow-runs/run-795']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <Routes>
            <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '执行详情' }), {
      button: 0,
      ctrlKey: false
    })

    expect(await screen.findByText('运行已开始')).toBeTruthy()
    expect(screen.queryByText('run.running')).toBeNull()
  })
})
