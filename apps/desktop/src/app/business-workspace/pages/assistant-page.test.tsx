import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { deliverableDetailRoute, DELIVERABLES_ROUTE, HISTORY_ROUTE, projectDetailRoute, routeDrawerNavigationState, workflowRunRoute } from '../../routes'

import { AssistantWorkspaceView } from './assistant-page'

const { deliverablesHook, navigate, projectsHook } = vi.hoisted(() => ({
  deliverablesHook: vi.fn(), navigate: vi.fn(), projectsHook: vi.fn()
}))

vi.mock('react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'zh' }) }))
vi.mock('../../im-entry', () => ({ ImEntryView: ({ embedded }: { embedded: boolean }) => <div data-testid="real-connections">{embedded ? 'embedded connections' : 'standalone connections'}</div> }))
vi.mock('../hooks/use-workflow-domain-lists', () => ({ useWorkflowProjects: projectsHook }))
vi.mock('../hooks/use-workflow-deliverables', () => ({ useWorkflowDeliverables: deliverablesHook }))

beforeEach(() => navigate.mockClear())
afterEach(() => cleanup())

describe('assistant workspace', () => {
  it('opens the same owned project run, attention project, and canonical deliverable as their source pages', () => {
    projectsHook.mockReturnValue({ mode: 'ready', items: [
      { id: 'project-running', name: 'Campaign run', summary: { currentRunId: 'run-1', currentRunStatus: 'running', attention: 'none' } },
      { id: 'project-review', name: 'Review project', summary: { currentRunId: 'run-2', currentRunStatus: 'waiting_review', attention: 'review' } },
      { id: 'project-older', name: 'Older project', summary: { currentRunId: null, currentRunStatus: null, attention: 'none' } }
    ] })
    deliverablesHook.mockReturnValue({ state: { mode: 'ready', items: [
      { id: 'older', title: 'Older output', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'newest', title: 'Latest output', updatedAt: '2026-09-28T00:00:00Z' }
    ] } })

    render(<AssistantWorkspaceView />)
    expect(screen.getByTestId('real-connections').textContent).toBe('embedded connections')
    expect(screen.queryByText('Older project')).toBeNull()

    fireEvent.click(screen.getByText('Campaign run').closest('button')!)
    expect(navigate).toHaveBeenCalledWith(workflowRunRoute('run-1'))
    fireEvent.click(screen.getByText('Review project').closest('button')!)
    expect(navigate).toHaveBeenCalledWith(projectDetailRoute('project-review'))
    fireEvent.click(screen.getByText('Latest output').closest('button')!)
    expect(navigate).toHaveBeenCalledWith(deliverableDetailRoute('newest'))
  })

  it('shows unavailable reads as unavailable, not fabricated empty histories', () => {
    projectsHook.mockReturnValue({ mode: 'failed' })
    deliverablesHook.mockReturnValue({ state: { mode: 'unavailable' } })

    render(<AssistantWorkspaceView />)
    expect(screen.getAllByText('暂时无法读取账号数据，请从对应页面重试。')).toHaveLength(3)
    expect(screen.queryByText('最近项目中没有正在运行的任务。')).toBeNull()
    expect(screen.queryByText('还没有项目交付物。')).toBeNull()
  })

  it('shows a real empty state and flags missing run summaries without inventing activity', () => {
    projectsHook.mockReturnValue({ mode: 'ready', items: [{ id: 'legacy', name: 'Older server project' }] })
    deliverablesHook.mockReturnValue({ state: { mode: 'ready', items: [] } })

    render(<AssistantWorkspaceView />)
    expect(screen.getByText('最近项目中没有正在运行的任务。')).toBeTruthy()
    expect(screen.getByText('部分项目没有运行摘要，请到项目页查看。')).toBeTruthy()
    expect(screen.getByText('还没有项目交付物。')).toBeTruthy()
  })
})

describe('hc-1123 product mode: 连接助手 stops pointing at project pages', () => {
  const backHere = { state: routeDrawerNavigationState({ hash: '', pathname: '/assistant', search: '', state: null }) }

  const seed = (items: unknown[]) => {
    projectsHook.mockReturnValue({ mode: 'ready', items })
    deliverablesHook.mockReturnValue({ state: { mode: 'ready', items: [{ id: 'newest', title: 'Latest output', updatedAt: '2026-09-28T00:00:00Z' }] } })
  }

  const row = (id: string, name: string, currentRunId: null | string, currentRunStatus: null | string, attention: string) =>
    ({ id, name, summary: { attention, currentRunId, currentRunStatus } })

  beforeEach(() => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('product')
  })

  afterEach(() => {
    setSingleThreadFlagForTest(false)
  })

  it('has no 查看项目, and every row opens its run with this page under it', () => {
    seed([row('p-running', 'Campaign run', 'run-1', 'running', 'none'), row('p-review', 'Review project', 'run-2', 'waiting_review', 'review'), row('p-failed', 'Failed project', 'run-3', 'failed', 'failed')])
    render(<AssistantWorkspaceView />)

    expect(screen.queryByRole('button', { name: '查看项目' })).toBeNull()

    for (const [name, runId] of [['Campaign run', 'run-1'], ['Review project', 'run-2'], ['Failed project', 'run-3']] as const) {
      fireEvent.click(screen.getByText(name).closest('button')!)
      expect(navigate).toHaveBeenLastCalledWith(workflowRunRoute(runId), backHere)
    }

    expect(navigate.mock.calls.filter(([path]) => String(path).startsWith('/projects'))).toEqual([])
  })

  it('keeps every other way out of the page', () => {
    seed([])
    render(<AssistantWorkspaceView />)

    fireEvent.click(screen.getByRole('button', { name: '查看会话历史' }))
    expect(navigate).toHaveBeenLastCalledWith(HISTORY_ROUTE)
    fireEvent.click(screen.getByRole('button', { name: '查看交付物' }))
    expect(navigate).toHaveBeenLastCalledWith(DELIVERABLES_ROUTE)
    fireEvent.click(screen.getByText('Latest output').closest('button')!)
    expect(navigate).toHaveBeenLastCalledWith(deliverableDetailRoute('newest'))
  })

  it.each([
    ['nothing to list', { mode: 'ready', items: [] }],
    ['an older server with no summaries', { mode: 'ready', items: [{ id: 'legacy', name: 'Older server' }] }],
    ['a project with no run', { mode: 'ready', items: [row('p-idle', 'Idle', null, null, 'none')] }],
    ['a project read still loading', { mode: 'loading' }],
    ['a project read that failed', { mode: 'failed' }]
  ])('says nothing about projects with %s', (_label, projects) => {
    projectsHook.mockReturnValue(projects)
    deliverablesHook.mockReturnValue({ state: { mode: 'ready', items: [] } })

    const { container } = render(<AssistantWorkspaceView />)

    expect(container.textContent).not.toContain('项目')
    expect(screen.getByText('查看消息渠道和最近的交付成果。')).toBeTruthy()
    expect(screen.getByText('还没有交付物。')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '消息渠道' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '最近交付' })).toBeTruthy()
  })

  it('a run listed beside a project with no summary sends nobody to the project page', () => {
    seed([row('p-running', 'Campaign run', 'run-1', 'running', 'none'), { id: 'legacy', name: 'Older server' }])
    render(<AssistantWorkspaceView />)

    expect(screen.getByText('Campaign run')).toBeTruthy()
    expect(screen.queryByText('部分项目没有运行摘要，请到项目页查看。')).toBeNull()
  })

  it('a project needing attention with no run to open is not a row at all', () => {
    seed([row('p-odd', 'No run yet', null, null, 'review')])
    render(<AssistantWorkspaceView />)

    expect(screen.queryByText('No run yet')).toBeNull()
    expect(screen.queryByRole('heading', { name: '需要处理' })).toBeNull()
  })

  it('developer mode keeps the project rows, buttons and copy', () => {
    setToolViewMode('technical')
    seed([row('p-review', 'Review project', 'run-2', 'waiting_review', 'review')])
    render(<AssistantWorkspaceView />)

    expect(screen.getAllByRole('button', { name: '查看项目' })).toHaveLength(2)
    fireEvent.click(screen.getByText('Review project').closest('button')!)
    expect(navigate).toHaveBeenLastCalledWith(projectDetailRoute('p-review'))
  })
})
