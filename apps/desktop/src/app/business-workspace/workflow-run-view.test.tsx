import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $previewTabs, $previewTarget } from '@/store/preview'

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
  }
}

describe('hc-795 real workflow Run view', () => {
  const cancelRun = vi.fn(async () => ({ ok: true }))
  const getRun = vi.fn(async () => ({ ok: true, overview }))
  const reviewDeliverable = vi.fn(async () => ({ ok: true }))

  beforeEach(() => {
    cancelRun.mockClear()
    getRun.mockClear()
    getRun.mockResolvedValue({ ok: true, overview })
    reviewDeliverable.mockClear()
    $previewTabs.set([])
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        workflowDomain: {
          access: vi.fn(),
          cancelRun,
          getRun,
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
    expect(screen.getByText('Analyze the US pet market')).toBeTruthy()
    expect(screen.getAllByText('Waiting for review')).toHaveLength(1)
    expect(screen.getByText('Pet market evidence report')).toBeTruthy()
    expect(screen.getByText(/1 evidence item/)).toBeTruthy()
    expect(screen.getByText('No stage progress to show yet')).toBeTruthy()
    expect(globalThis.document.querySelector('[data-stage-empty-state="compact"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'No openable result yet' }).hasAttribute('disabled')).toBe(true)

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

  it('routes request-changes through the same Review exit and refreshes authoritative data', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    await waitFor(() =>
      expect(reviewDeliverable).toHaveBeenCalledWith({
        deliverableId: 'deliverable-1',
        status: 'changes_requested'
      })
    )
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2))
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

  it('opens only an explicit real deliverable target through the existing preview seam', async () => {
    getRun.mockResolvedValue({
      ok: true,
      overview: {
        ...overview,
        deliverables: [
          {
            ...overview.deliverables[0],
            openReference: 'https://files.example/report.pdf'
          }
        ]
      }
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

    fireEvent.click(await screen.findByRole('button', { name: 'Open deliverable' }))

    await waitFor(() => expect($previewTarget.get()?.url).toBe('https://files.example/report.pdf'))
    expect($previewTarget.get()?.label).toBe('Pet market evidence report')
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
})
