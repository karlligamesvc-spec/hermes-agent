import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { WorkflowRunView } from './workflow-run-view'

const overview = {
  deliverables: [
    {
      createdAt: '2026-08-27T10:03:00Z',
      evidenceManifest: [{ url: 'https://example.com/evidence' }],
      id: 'deliverable-1',
      kind: 'report',
      payload: {},
      reviews: [],
      status: 'ready',
      title: 'Pet market evidence report',
      updatedAt: '2026-08-27T10:03:00Z'
    }
  ],
  events: [
    {
      eventKey: 'run-795:1',
      eventType: 'run.queued',
      happenedAt: '2026-08-27T10:00:00Z',
      id: 'event-1',
      payload: {},
      sequence: 1
    },
    {
      eventKey: 'run-795:2',
      eventType: 'run.waiting_review',
      happenedAt: '2026-08-27T10:03:00Z',
      id: 'event-2',
      payload: {},
      sequence: 2
    }
  ],
  run: {
    attempt: 1,
    completedAt: null,
    createdAt: '2026-08-27T10:00:00Z',
    errorCode: null,
    errorMessage: null,
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
  const getRun = vi.fn(async () => ({ ok: true, overview }))
  const reviewDeliverable = vi.fn(async () => ({ ok: true }))

  beforeEach(() => {
    getRun.mockClear()
    reviewDeliverable.mockClear()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        workflowDomain: {
          access: vi.fn(),
          cancelRun: vi.fn(),
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
    expect(screen.getByText('Run queued')).toBeTruthy()
    expect(screen.getAllByText('Waiting for review')).toHaveLength(2)
    expect(screen.getByText('Pet market evidence report')).toBeTruthy()
    expect(screen.getByText(/1 evidence item/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Approve deliverable' }))

    await waitFor(() =>
      expect(reviewDeliverable).toHaveBeenCalledWith({ deliverableId: 'deliverable-1', status: 'approved' })
    )
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2))
  })
})
