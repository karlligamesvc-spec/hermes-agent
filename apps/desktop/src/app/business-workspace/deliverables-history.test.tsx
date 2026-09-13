import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { WorkflowDeliverableDetail } from './api/types'
import { DeliverableDetailView } from './pages/deliverable-detail-page'
import { DeliverablesView } from './pages/deliverables-page'
import { HistoryView } from './pages/history-page'

const item = {
  createdAt: '2026-09-13T01:00:00Z',
  evidence: [
    {
      quote: 'Revenue increased after the listing update.',
      title: 'Store report',
      url: 'https://example.com/report',
      verified: true
    }
  ],
  executorType: 'hermes' as const,
  executorVersion: '2026.9.1',
  id: 'deliverable/831',
  kind: 'report',
  payload: {
    content: 'Full report content',
    highlights: ['US demand grew'],
    summary: 'Evidence-backed market report'
  },
  projectId: 'project-831',
  reviews: [],
  runId: 'run-831',
  schemaVersion: 1,
  sourceCapturedAt: '2026-09-13T00:59:00Z',
  status: 'ready',
  storageTarget: { id: '00000000-0000-4000-8000-000000000831', kind: 'user_file' as const },
  title: 'Pet market report',
  updatedAt: '2026-09-13T01:10:00Z',
  verifierResult: { evidenceCount: 1, passed: true, status: 'passed' }
}

const detail: WorkflowDeliverableDetail = {
  item,
  project: {
    createdAt: '2026-09-13T00:00:00Z',
    id: 'project-831',
    name: 'Pet market',
    objective: 'Research the US pet market',
    status: 'active',
    updatedAt: '2026-09-13T01:10:00Z'
  },
  run: {
    completedAt: null,
    createdAt: '2026-09-13T00:30:00Z',
    id: 'run-831',
    startedAt: '2026-09-13T00:31:00Z',
    status: 'waiting_review',
    updatedAt: '2026-09-13T01:10:00Z'
  },
  workflow: {
    createdAt: '2026-09-13T00:15:00Z',
    description: 'Market research workflow',
    id: 'workflow-831',
    name: 'Market research',
    projectId: 'project-831',
    slug: 'market-research',
    status: 'active',
    updatedAt: '2026-09-13T00:15:00Z',
    version: 1
  }
}

function LocationProbe() {
  const location = useLocation()

  const drawer = location.state as {
    routeDrawer?: { backgroundLocation?: { pathname?: string }; returnFocusKey?: string }
  } | null

  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="drawer-source">{drawer?.routeDrawer?.backgroundLocation?.pathname || ''}</output>
      <output data-testid="return-focus">{drawer?.routeDrawer?.returnFocusKey || ''}</output>
    </>
  )
}

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    access: vi.fn(async () => ({ available: true })),
    cancelRun: vi.fn(),
    getDeliverable: vi.fn(async () => ({ detail, ok: true })),
    getRun: vi.fn(),
    listActivity: vi.fn(async () => ({
      items: [
        {
          happenedAt: new Date().toISOString(),
          id: 'review:831',
          kind: 'review' as const,
          status: 'changes_requested',
          summary: 'Changes requested with evidence notes',
          target: { id: 'deliverable/831', kind: 'deliverable' as const },
          title: 'Review saved'
        }
      ],
      nextCursor: null,
      ok: true
    })),
    listDeliverables: vi.fn(async () => ({ items: [item], nextCursor: null, ok: true })),
    openUserFile: vi.fn(async () => ({ ok: true })),
    reviewDeliverable: vi.fn(async () => ({ ok: true })),
    startGoal: vi.fn(),
    ...overrides
  }

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { workflowDomain: bridge }
  })

  return bridge
}

beforeEach(() => {
  installBridge()
})

describe('hc-831 Deliverables and Activity loop', () => {
  it('opens a real Deliverable route from the canonical list with restorable focus state', async () => {
    const bridge = installBridge()

    render(
      <MemoryRouter initialEntries={['/deliverables']}>
        <I18nProvider configClient={null} initialLocale="en">
          <DeliverablesView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('Pet market report')).toBeTruthy()
    expect(screen.getByText('1 deliverable')).toBeTruthy()
    expect(bridge.listDeliverables).toHaveBeenCalledWith({ kind: undefined, limit: 50, status: undefined })

    fireEvent.click(screen.getByRole('button', { name: /Pet market report/ }))

    expect(screen.getByTestId('location').textContent).toBe('/deliverables/deliverable%2F831')
    expect(screen.getByTestId('drawer-source').textContent).toBe('/deliverables')
    expect(screen.getByTestId('return-focus').textContent).toBe('deliverable:deliverable/831')
  })

  it('opens only the typed user-file id and preserves a rejected revision note for retry', async () => {
    const reviewDeliverable = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true })
    const bridge = installBridge({ reviewDeliverable })

    render(
      <MemoryRouter initialEntries={['/deliverables/deliverable%2F831']}>
        <I18nProvider configClient={null} initialLocale="en">
          <Routes>
            <Route element={<DeliverableDetailView />} path="deliverables/:deliverableId" />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByRole('heading', { name: 'Pet market report' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open result' }))
    await waitFor(() => expect(bridge.openUserFile).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000831'))

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    expect(screen.getByText('Add a revision note.')).toBeTruthy()
    expect(reviewDeliverable).not.toHaveBeenCalled()

    const note = screen.getByPlaceholderText('Describe what should change, the evidence, or the expected result')
    fireEvent.change(note, { target: { value: 'Cite the primary source.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    expect(await screen.findByText('The review was not saved. Your note is still here; try again.')).toBeTruthy()
    expect((note as HTMLTextAreaElement).value).toBe('Cite the primary source.')
    expect(reviewDeliverable).toHaveBeenLastCalledWith({
      deliverableId: 'deliverable/831',
      notes: 'Cite the primary source.',
      status: 'changes_requested'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    await waitFor(() => expect(reviewDeliverable).toHaveBeenCalledTimes(2))
  })

  it('uses the Activity target envelope for review and run navigation without title inference', async () => {
    const listActivity = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            happenedAt: new Date().toISOString(),
            id: 'review:831',
            kind: 'review',
            status: 'changes_requested',
            summary: 'Needs a new citation',
            target: { id: 'deliverable/831', kind: 'deliverable' },
            title: 'Title does not contain an id'
          }
        ],
        nextCursor: null,
        ok: true
      })
      .mockResolvedValueOnce({
        items: [
          {
            happenedAt: new Date().toISOString(),
            id: 'run:831',
            kind: 'run',
            status: 'running',
            summary: null,
            target: { id: 'run/831', kind: 'run' },
            title: 'Another opaque title'
          }
        ],
        nextCursor: null,
        ok: true
      })

    installBridge({ listActivity })

    const first = render(
      <MemoryRouter initialEntries={['/history']}>
        <I18nProvider configClient={null} initialLocale="en">
          <HistoryView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByRole('button', { name: /Title does not contain an id/ }))
    expect(screen.getByTestId('location').textContent).toBe('/deliverables/deliverable%2F831')
    expect(screen.getByTestId('drawer-source').textContent).toBe('/history')

    first.unmount()
    render(
      <MemoryRouter initialEntries={['/history']}>
        <I18nProvider configClient={null} initialLocale="en">
          <HistoryView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByRole('button', { name: /Another opaque title/ }))
    expect(screen.getByTestId('location').textContent).toBe('/workflow-runs/run%2F831')
  })

  it('shows an honest unavailable state when the new read exit is absent', async () => {
    installBridge({ listDeliverables: undefined })

    render(
      <MemoryRouter initialEntries={['/deliverables']}>
        <I18nProvider configClient={null} initialLocale="en">
          <DeliverablesView />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('Live deliverables are not connected')).toBeTruthy()
    expect(screen.queryByText('Pet market report')).toBeNull()
  })

  it('does not append an old Deliverable cursor after a newer refresh wins', async () => {
    let initialReads = 0
    let resolveOldPage!: (value: { items: (typeof item)[]; nextCursor: null; ok: true }) => void

    const oldPage = new Promise<{ items: (typeof item)[]; nextCursor: null; ok: true }>(resolve => {
      resolveOldPage = resolve
    })

    const refreshed = { ...item, id: 'deliverable-refreshed', title: 'Refreshed result' }
    const stale = { ...item, id: 'deliverable-stale', title: 'Stale cursor result' }

    const listDeliverables = vi.fn(async (options?: { cursor?: string }) => {
      if (options?.cursor) {
        return oldPage
      }

      initialReads += 1

      return initialReads === 1
        ? { items: [item], nextCursor: 'old cursor', ok: true }
        : { items: [refreshed], nextCursor: null, ok: true }
    })

    installBridge({ listDeliverables })

    render(
      <MemoryRouter initialEntries={['/deliverables']}>
        <I18nProvider configClient={null} initialLocale="en">
          <DeliverablesView />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('Pet market report')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Refreshed result')).toBeTruthy()

    await act(async () => {
      resolveOldPage({ items: [stale], nextCursor: null, ok: true })
      await oldPage
    })

    expect(screen.queryByText('Stale cursor result')).toBeNull()
  })

  it('does not append an old Activity cursor after the user changes the typed filter', async () => {
    let resolveOldPage!: (value: {
      items: Array<{
        happenedAt: string
        id: string
        kind: 'review'
        status: string
        summary: string
        target: { id: string; kind: 'deliverable' }
        title: string
      }>
      nextCursor: null
      ok: true
    }) => void

    const oldPage = new Promise<Parameters<typeof resolveOldPage>[0]>(resolve => {
      resolveOldPage = resolve
    })

    const listActivity = vi.fn(async (options?: { cursor?: string; kinds?: string }) => {
      if (options?.cursor) {
        return oldPage
      }

      if (options?.kinds === 'run') {
        return {
          items: [
            {
              happenedAt: new Date().toISOString(),
              id: 'run:new',
              kind: 'run' as const,
              status: 'running',
              summary: 'Current run result',
              target: { id: 'run-new', kind: 'run' as const },
              title: 'Current filtered run'
            }
          ],
          nextCursor: null,
          ok: true
        }
      }

      return {
        items: [
          {
            happenedAt: new Date().toISOString(),
            id: 'review:first',
            kind: 'review' as const,
            status: 'approved',
            summary: 'First page',
            target: { id: 'deliverable-first', kind: 'deliverable' as const },
            title: 'Initial activity'
          }
        ],
        nextCursor: 'old cursor',
        ok: true
      }
    })

    installBridge({ listActivity })

    render(
      <MemoryRouter initialEntries={['/history']}>
        <I18nProvider configClient={null} initialLocale="en">
          <HistoryView />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('Initial activity')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(await screen.findByText('Current filtered run')).toBeTruthy()

    await act(async () => {
      resolveOldPage({
        items: [
          {
            happenedAt: new Date().toISOString(),
            id: 'review:stale',
            kind: 'review',
            status: 'changes_requested',
            summary: 'Old page',
            target: { id: 'deliverable-stale', kind: 'deliverable' },
            title: 'Stale activity result'
          }
        ],
        nextCursor: null,
        ok: true
      })
      await oldPage
    })

    expect(screen.queryByText('Stale activity result')).toBeNull()
  })
})
