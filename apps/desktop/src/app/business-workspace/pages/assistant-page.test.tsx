import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deliverableDetailRoute, projectDetailRoute, workflowRunRoute } from '../../routes'

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
