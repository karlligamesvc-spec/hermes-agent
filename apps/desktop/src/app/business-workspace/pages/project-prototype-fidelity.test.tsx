import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $authState } from '@/store/auth'

import { workflowDomainChanged } from '../api/read-revision'
import type { WorkflowDeliverable, WorkflowDomainBridge, WorkflowProject, WorkflowProjectCompletion } from '../api/types'
import { useProjectListCompletions } from '../hooks/use-project-list-completions'
import { PROJECT_PROTOTYPE_COPY } from '../project-prototype-copy'

import { ProjectDetailView } from './project-detail-page'
import { ProjectsView } from './projects-page'
import { WorkflowsView } from './workflows-page'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })

  return { promise, resolve }
}

function project(id: string, status = 'active'): WorkflowProject {
  return { id, status, name: id, objective: `Objective ${id}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T01:00:00Z',
    summary: { attention: 'none', currentRunId: 'successful-current-run', currentRunStatus: 'succeeded', currentStepTitle: null, deliverableCount: 1, stepCompleted: 3, stepTotal: 3 } }
}

function completion(statuses: Array<string | null>, projectStatus = 'active'): WorkflowProjectCompletion {
  const succeeded = statuses.filter(status => status === 'succeeded').length
  const readyForReview = statuses.length > 0 && succeeded === statuses.length

  return { projectStatus, canComplete: projectStatus === 'active' && readyForReview, readyForReview,
    workflowSucceeded: succeeded, workflowTotal: statuses.length,
    workflowStates: statuses.map((runStatus, index) => ({ workflowId: `workflow-${index}`, runId: runStatus ? `run-${index}` : null, runStatus })) }
}

function bridge(overrides: Partial<WorkflowDomainBridge>) {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { workflowDomain: {
    access: vi.fn(async () => ({ available: true })), cancelRun: vi.fn(), getRun: vi.fn(), reviewDeliverable: vi.fn(), startGoal: vi.fn(), ...overrides
  } } })
}

function Location() {
  return <output data-testid="project-location">{useLocation().pathname}</output>
}

beforeEach(() => {
  $authState.set({ ...$authState.get(), enabled: false })
  workflowDomainChanged()
})

describe('Projects prototype hierarchy backed by authoritative domain reads', () => {
  it.each(['zh', 'zh-hant', 'en', 'ja', 'ar'] as const)('shows five real filters and never treats the current successful Run as whole-project acceptance in %s', async locale => {
    const copy = PROJECT_PROTOTYPE_COPY[locale]

    const states = new Map([
      ['empty', completion([])], ['unstarted', completion([null, null])], ['partial', completion(['succeeded', 'running'])],
      ['failed', completion(['failed'])], ['blocked', completion(['blocked'])], ['review', completion(['awaiting_review'])],
      ['acceptance', completion(['succeeded', 'succeeded'])]
    ])

    const items = [...states.keys(), 'unknown', 'paused', 'archived', 'completed'].map(id => project(id, ['paused', 'archived', 'completed'].includes(id) ? id : 'active'))
    bridge({ listProjects: vi.fn(async () => ({ ok: true, items, total: items.length })), getProjectCompletion: vi.fn(async id => {
      const facts = states.get(id)

      return facts ? { ok: true, completion: facts } : { ok: false }
    }) })
    render(<MemoryRouter><I18nProvider configClient={null} initialLocale={locale}><ProjectsView /></I18nProvider></MemoryRouter>)
    const filters = within(await screen.findByRole('group'))
    await waitFor(() => expect(filters.queryByRole('button', { name: `${copy.filters['in-progress']}4` })).toBeTruthy())

    const choose = (key: keyof typeof copy.filters, count: number) => {
      const button = filters.queryByRole('button', { name: `${copy.filters[key]}${count}` })
      expect(button).not.toBeNull()
      fireEvent.click(button!)
    }

    choose('awaiting-acceptance', 1)
    expect(screen.getByRole('button', { name: /^acceptance/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^partial/ })).toBeNull()
    choose('not-started', 2)
    expect(screen.getByRole('button', { name: /^unstarted/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^unknown/ })).toBeNull()
    choose('completed', 1)
    expect(screen.getByRole('button', { name: /^completed/ })).toBeTruthy()
    choose('all', items.length)
    expect(screen.getByRole('button', { name: /^unknown/ }).textContent).toContain(copy.unknown)
    expect(screen.getByRole('button', { name: /^paused/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^archived/ })).toBeTruthy()
    const partial = screen.getByRole('button', { name: /^partial/ })
    expect(within(partial).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    expect(within(partial).getByRole('progressbar').getAttribute('aria-valuemax')).toBe('2')
  })

  it('limits loaded-project completion reads to four, shares concurrent reads, and refreshes after revision changes', async () => {
    const pending = Array.from({ length: 6 }, () => deferred<{ ok: true; completion: WorkflowProjectCompletion }>())
    const getProjectCompletion = vi.fn((id: string) => pending[Number(id)].promise)
    bridge({ getProjectCompletion })
    const first = renderHook(() => useProjectListCompletions(['0', '1', '2', '3', '4', '5']))
    const second = renderHook(() => useProjectListCompletions(['0', '1']))
    await waitFor(() => expect(getProjectCompletion).toHaveBeenCalledTimes(4))
    expect(getProjectCompletion.mock.calls.map(([id]) => id)).toEqual(['0', '1', '2', '3'])
    await act(async () => {pending[0].resolve({ ok: true, completion: completion([]) })})
    await waitFor(() => expect(getProjectCompletion).toHaveBeenCalledTimes(5))
    await act(async () => {pending.slice(1).forEach(item => item.resolve({ ok: true, completion: completion([]) }))})
    await waitFor(() => expect(first.result.current.mode).toBe('ready'))
    expect(second.result.current.mode).toBe('ready')
    expect(getProjectCompletion).toHaveBeenCalledTimes(6)
    await act(async () => {workflowDomainChanged()})
    await waitFor(() => expect(getProjectCompletion).toHaveBeenCalledTimes(12))
  })

  it('rejects late completion data from the old owner and does not overwrite the new owner projection', async () => {
    const old = deferred<{ ok: true; completion: WorkflowProjectCompletion }>()
    $authState.set({ ...$authState.get(), enabled: true, status: 'signed-in', accountId: 'owner-a' })
    const read = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ ok: true, completion: completion([]) })
    bridge({ getProjectCompletion: read })
    const view = renderHook(() => useProjectListCompletions(['same-project']))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await act(async () => {$authState.set({ ...$authState.get(), accountId: 'owner-b' })})
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.result.current.mode).toBe('ready'))
    await act(async () => {old.resolve({ ok: true, completion: completion(['succeeded']) })})
    expect(view.result.current.mode === 'ready' && view.result.current.items.get('same-project')).toEqual({ mode: 'ready', completion: completion([]) })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('retries a failed completion read without changing or creating Projects', async () => {
    const read = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, completion: completion([]) })
    const createProject = vi.fn()
    bridge({ createProject, getProjectCompletion: read, listProjects: vi.fn(async () => ({ ok: true, items: [project('retry')], total: 1 })) })
    render(<MemoryRouter><I18nProvider configClient={null} initialLocale="zh"><ProjectsView /></I18nProvider></MemoryRouter>)
    await screen.findByText(PROJECT_PROTOTYPE_COPY.zh.unknown)
    fireEvent.click(screen.getByRole('button', { name: '重试刷新' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '待开始1' })).toBeTruthy())
    expect(read).toHaveBeenCalledTimes(2)
    expect(createProject).not.toHaveBeenCalled()
  })

  it('rejects late completion data after a newer domain revision has been read', async () => {
    const old = deferred<{ ok: true; completion: WorkflowProjectCompletion }>()
    const read = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ ok: true, completion: completion([]) })
    bridge({ getProjectCompletion: read })
    const view = renderHook(() => useProjectListCompletions(['revised-project']))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await act(async () => {workflowDomainChanged()})
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.result.current.mode).toBe('ready'))
    await act(async () => {old.resolve({ ok: true, completion: completion(['succeeded']) })})
    expect(view.result.current.mode === 'ready' && view.result.current.items.get('revised-project')).toEqual({ mode: 'ready', completion: completion([]) })
  })

  it('counts and reads only loaded Projects while keeping the server total explicit', async () => {
    const getProjectCompletion = vi.fn(async (_projectId: string) => ({ ok: true, completion: completion([]) }))
    bridge({ getProjectCompletion, listProjects: vi.fn(async () => ({ ok: true, items: [project('loaded-a'), project('loaded-b')], total: 200 })) })
    render(<MemoryRouter><I18nProvider configClient={null} initialLocale="zh"><ProjectsView /></I18nProvider></MemoryRouter>)
    await waitFor(() => expect(screen.queryByRole('button', { name: '待开始2' })).toBeTruthy())
    expect(screen.getByRole('button', { name: '全部2' })).toBeTruthy()
    expect(screen.getByText(/200 个项目.*已加载 2 个项目/)).toBeTruthy()
    expect(getProjectCompletion.mock.calls.map(([id]) => id)).toEqual(['loaded-a', 'loaded-b'])
  })

  it('makes Projects and Workflow library peer entries mutually reachable without creating anything', async () => {
    const createProject = vi.fn()
    const startGoal = vi.fn()
    bridge({ createProject, startGoal, listProjects: vi.fn(async () => ({ ok: true, items: [], total: 0 })) })
    render(<MemoryRouter initialEntries={['/projects']}><I18nProvider configClient={null} initialLocale="zh">
      <Routes><Route element={<ProjectsView />} path="/projects" /><Route element={<WorkflowsView />} path="/workflows" /></Routes><Location />
    </I18nProvider></MemoryRouter>)
    expect(within(screen.getByRole('group')).getAllByRole('button')).toHaveLength(5)
    fireEvent.click(await screen.findByRole('button', { name: '工作流库' }))
    expect(screen.getByTestId('project-location').textContent).toBe('/workflows')
    fireEvent.click(screen.getByRole('button', { name: '我的项目' }))
    expect(screen.getByTestId('project-location').textContent).toBe('/projects')
    expect(createProject).not.toHaveBeenCalled()
    expect(startGoal).not.toHaveBeenCalled()
  })

  it.each(['zh', 'zh-hant', 'en', 'ja', 'ar'] as const)('renders the three drawer tabs, four real lifecycle stages, and owner-scoped results in %s', async locale => {
    const copy = PROJECT_PROTOTYPE_COPY[locale]
    const item = project('drawer-project')
    const result: WorkflowDeliverable = { id: 'real-result', title: 'Recorded result', projectId: item.id, status: 'ready', evidence: [], createdAt: item.createdAt, updatedAt: item.updatedAt, executorType: 'hermes', executorVersion: null, kind: 'report', payload: { content: 'Actual report' }, reviews: [], runId: 'run-0', schemaVersion: 'deliverable/v1', sourceCapturedAt: null, storageTarget: null, verifierResult: null }
    const readResults = vi.fn(async () => ({ ok: true, items: [result], nextCursor: null }))
    bridge({ getProject: vi.fn(async () => ({ ok: true, item })), getProjectCompletion: vi.fn(async () => ({ ok: true, completion: completion(['succeeded', 'running']) })),
      listWorkflows: vi.fn(async () => ({ ok: true, items: [] })), listDeliverables: readResults })
    render(<MemoryRouter initialEntries={['/projects/drawer-project']}><I18nProvider configClient={null} initialLocale={locale}>
      <Routes><Route element={<ProjectDetailView />} path="/projects/:projectId" /><Route element={<Location />} path="/deliverables/:deliverableId" /></Routes>
    </I18nProvider></MemoryRouter>)
    await screen.findByRole('heading', { name: item.name })
    const rail = within(screen.getByRole('list', { name: copy.progress }))
    await waitFor(() => expect(rail.getByText(copy.stages[1]).closest('li')?.getAttribute('data-complete')).toBe('true'))
    expect(rail.getAllByRole('listitem')).toHaveLength(4)
    expect(rail.getByText(copy.stages[2]).closest('li')?.getAttribute('data-complete')).toBe('false')
    expect(rail.getByText(copy.stages[3]).closest('li')?.getAttribute('data-complete')).toBe('false')
    expect(readResults).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByRole('tab', { name: `${copy.workflows} 2` }))
    expect(screen.getByRole('tabpanel').textContent).not.toContain(copy.goal)
    fireEvent.mouseDown(screen.getByRole('tab', { name: `${copy.results} 1` }))
    fireEvent.click(await screen.findByRole('button', { name: /Recorded result/ }))
    expect(readResults).toHaveBeenCalledWith({ projectId: item.id, limit: 50 })
    expect(screen.getByTestId('project-location').textContent).toBe('/deliverables/real-result')
  })
})
