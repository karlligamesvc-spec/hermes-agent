import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import { workflowDomainChanged } from '../api/read-revision'
import type { WorkflowDomainBridge, WorkflowProject } from '../api/types'
import { PROJECT_PROTOTYPE_COPY } from '../project-prototype-copy'

import { ProjectDetailView } from './project-detail-page'
import { ProjectsView } from './projects-page'

const locales = [
  ['zh', zh], ['zh-hant', zhHant], ['en', en], ['ja', ja], ['ar', ar]
] as const

function project(id: string, status = 'active'): WorkflowProject {
  return {
    createdAt: '2026-09-01T10:00:00Z',
    id,
    name: id,
    objective: 'A real business objective',
    status,
    summary: {
      attention: 'none', currentRunId: `run-${id}`, currentRunStatus: 'succeeded',
      currentStepTitle: 'Recorded step', deliverableCount: 1, stepCompleted: 3, stepTotal: 3
    },
    updatedAt: '2026-09-04T10:00:00Z'
  }
}

function installBridge(overrides: Partial<WorkflowDomainBridge>) {
  workflowDomainChanged()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { workflowDomain: {
      access: vi.fn(async () => ({ available: true })), cancelRun: vi.fn(), getRun: vi.fn(),
      reviewDeliverable: vi.fn(), startGoal: vi.fn(), ...overrides
    } }
  })
}

describe('Project acceptance and Run success have separate authority', () => {
  it.each(locales)('shows and filters the Project lifecycle independently of a successful Run in %s', async (locale, translations) => {
    const copy = translations.businessWorkspace.projects
    const prototype = PROJECT_PROTOTYPE_COPY[locale]
    const completeProject = vi.fn()
    installBridge({
      completeProject,
      getProjectCompletion: vi.fn(async () => ({ completion: {
        canComplete: false, projectStatus: 'active', readyForReview: false, workflowSucceeded: 1, workflowTotal: 2,
        workflowStates: [{ workflowId: 'one', runId: 'run-one', runStatus: 'succeeded' }, { workflowId: 'two', runId: 'run-two', runStatus: 'running' }]
      }, ok: true })),
      listProjects: vi.fn(async () => ({
        items: [project('awaiting-project'), project('finished-project', 'completed'),
          project('archived-project', 'archived'), project('paused-project', 'paused')],
        ok: true, total: 4
      }))
    })

    render(<MemoryRouter initialEntries={['/projects']}>
      <I18nProvider configClient={null} initialLocale={locale}><ProjectsView /></I18nProvider>
    </MemoryRouter>)

    const awaiting = await screen.findByRole('button', { name: /awaiting-project/ })
    expect(within(awaiting).getByText(copy.lifecycle('active'))).toBeTruthy()
    expect(within(awaiting).getByText(copy.runLifecycle('succeeded'))).toBeTruthy()
    expect(within(awaiting).queryByText(copy.lifecycle('completed'))).toBeNull()
    expect(within(awaiting).getByText(copy.currentStep('Recorded step'))).toBeTruthy()
    const filters = within(screen.getByRole('group', { name: copy.filters.label }))
    const completed = filters.getByRole('button', { name: `${prototype.filters.completed}1` })
    fireEvent.click(completed)
    expect(screen.getByRole('button', { name: /finished-project/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /awaiting-project|archived-project|paused-project/ })).toBeNull()
    await waitFor(() => expect(filters.getByRole('button', { name: `${prototype.filters['in-progress']}1` })).toBeTruthy())
    fireEvent.click(filters.getByRole('button', { name: `${prototype.filters['in-progress']}1` }))
    expect(screen.getByRole('button', { name: /awaiting-project/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /paused-project/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /finished-project|archived-project|paused-project/ })).toBeNull()
    expect(within(awaiting).queryByText(prototype.filters['awaiting-acceptance'])).toBeNull()
    expect(completeProject).not.toHaveBeenCalled()
  })

  it('uses all latest Workflow runs for acceptance and changes lifecycle only after explicit finish and reopen', async () => {
    let item = project('manual-project')

    const completeProject = vi.fn(async () => {
      item = { ...item, status: 'completed' }

      return { item, ok: true }
    })

    const reopenProject = vi.fn(async () => {
      item = { ...item, status: 'active' }

      return { item, ok: true }
    })

    let allSucceeded = false
    installBridge({
      completeProject, reopenProject,
      getProject: vi.fn(async () => ({ item, ok: true })),
      getProjectCompletion: vi.fn(async () => ({ completion: {
        canComplete: allSucceeded && item.status === 'active', projectStatus: item.status,
        readyForReview: allSucceeded, workflowSucceeded: allSucceeded ? 2 : 1, workflowTotal: 2,
        workflowStates: [
          { workflowId: 'successful-workflow', runId: 'run-manual-project', runStatus: 'succeeded' },
          { workflowId: 'other-workflow', runId: 'run-other', runStatus: allSucceeded ? 'succeeded' : 'running' }
        ]
      }, ok: true })),
      listWorkflows: vi.fn(async () => ({ items: [], ok: true }))
    })

    const open = () => render(<MemoryRouter initialEntries={[{
      pathname: '/projects/manual-project',
      state: { businessProjectSummary: { ...item.summary, currentRunId: 'stale-route-run', currentRunStatus: 'running' } }
    }]}>
      <I18nProvider configClient={null} initialLocale="zh">
        <Routes><Route element={<ProjectDetailView />} path="/projects/:projectId" /></Routes>
      </I18nProvider>
    </MemoryRouter>)

    const view = open()
    await screen.findByRole('tab', { name: '成果 1' })
    expect(screen.getByText('运行成功')).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: '成果 1' }))
    const finish = await screen.findByRole('button', { name: '完成项目' })
    expect(finish.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('Hermes 正在执行')).toBeNull()
    expect(screen.queryByText('待验收')).toBeNull()
    expect(completeProject).not.toHaveBeenCalled()

    allSucceeded = true
    view.unmount()
    open()
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '成果 1' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '完成项目' }).hasAttribute('disabled')).toBe(false))
    expect(screen.getAllByText('待验收').length).toBeGreaterThan(0)
    expect(item.status).toBe('active')
    expect(completeProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '完成项目' }))
    await screen.findByRole('button', { name: '重新打开项目' })
    expect(item.status).toBe('completed')
    expect(completeProject).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(screen.getByRole('tab', { name: '工作流 2' }))
    expect(screen.getByRole('button', { name: '增加工作流' }).hasAttribute('disabled')).toBe(true)
    fireEvent.mouseDown(screen.getByRole('tab', { name: '成果 1' }))
    fireEvent.click(screen.getByRole('button', { name: '重新打开项目' }))
    await waitFor(() => expect(item.status).toBe('active'))
    fireEvent.mouseDown(screen.getByRole('tab', { name: '工作流 2' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '增加工作流' }).hasAttribute('disabled')).toBe(false))
    expect(item.status).toBe('active')
    expect(reopenProject).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('待验收').length).toBeGreaterThan(0)
    fireEvent.mouseDown(screen.getByRole('tab', { name: '概览' }))
    expect(screen.getByText('运行成功')).toBeTruthy()
  })
})
