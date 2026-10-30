import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  CATALOG,
  PROJECTS,
  SAVED_WORKFLOWS,
  seedSignedIn,
  VIDEO_CATALOG
} from '../../../__identity__/fold-projects/render'

import { WorkflowsView } from './workflows-page'

/**
 * hc-1123: `/workflows` stays open in product mode, but it is no way into a
 * project page and no way to make a project nobody could then see. The switch
 * off and developer mode are pinned in src/fold-projects-pages-identity.test.tsx.
 */

const hooks = vi.hoisted(() => ({ definitions: vi.fn(), project: vi.fn(), projects: vi.fn() }))

vi.mock('../hooks/use-workflow-domain-lists', async importOriginal => ({
  ...(await importOriginal<object>()),
  useVideoWorkflowCatalog: () => VIDEO_CATALOG,
  useWorkflowCatalog: () => CATALOG,
  useWorkflowDefinitions: hooks.definitions,
  useWorkflowProject: hooks.project,
  useWorkflowProjects: hooks.projects
}))

const visited: string[] = []

function Where() {
  const location = useLocation()

  visited.push(location.pathname)

  return <output data-testid="where">{location.pathname}</output>
}

function renderLibrary(path = '/workflows') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider configClient={null} initialLocale="zh">
        <Where />
        <WorkflowsView />
      </I18nProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  seedSignedIn()
  visited.length = 0
  hooks.definitions.mockReturnValue({ items: SAVED_WORKFLOWS, mode: 'ready' })
  hooks.project.mockImplementation((id?: string) =>
    id ? { item: PROJECTS[3], mode: 'ready' } : { mode: 'unavailable' }
  )
  hooks.projects.mockReturnValue({ items: PROJECTS, mode: 'ready' })
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

describe('hc-1123 /workflows in product mode', () => {
  it('has no 项目 | 工作流库 tabs', () => {
    renderLibrary()

    expect(screen.queryByRole('button', { name: '我的项目' })).toBeNull()
    expect(screen.queryByRole('button', { name: '工作流库' })).toBeNull()
  })

  it('a saved workflow is a row to read: no button, no arrow, nowhere to go', () => {
    renderLibrary()

    const row = screen.getByText('每周看一次竞品').closest('[data-saved-workflow-row]')!

    expect(row).toBeTruthy()
    expect(row.closest('button')).toBeNull()
    expect(row.querySelector('[data-icon="arrow-right"], .codicon-arrow-right')).toBeNull()

    fireEvent.click(row)
    expect(screen.getByTestId('where').textContent).toBe('/workflows')
  })

  it('a template opens its details with no project buttons, and 取消 closes them', async () => {
    renderLibrary()

    fireEvent.click(document.querySelector('[data-recommended-workflows] button')!)
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).queryByRole('button', { name: '加入已有项目' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '新建项目并加入' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '加入当前项目' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a ?projectId= link is the same library: no 返回项目, no project context', () => {
    renderLibrary('/workflows?projectId=project-failed')

    expect(screen.queryByRole('button', { name: '返回项目' })).toBeNull()
    expect(document.querySelector('[data-project-workflow-context]')).toBeNull()
    expect(hooks.project).toHaveBeenLastCalledWith(undefined)
  })

  it('开始一个目标 still goes back to the conversation', () => {
    renderLibrary()

    fireEvent.click(screen.getByRole('button', { name: '开始一个目标' }))

    expect(screen.getByTestId('where').textContent).toBe('/')
  })

  it.each(['/workflows', '/workflows?projectId=project-failed'])(
    'no button on %s reaches a project page, whichever is pressed',
    async path => {
      renderLibrary(path)

      const labels = screen.getAllByRole('button').length

      for (let index = 0; index < labels; index += 1) {
        cleanup()
        renderLibrary(path)
        fireEvent.click(screen.getAllByRole('button')[index]!)

        for (const button of screen.queryAllByRole('button')) {
          if (button.closest('[role="dialog"]')) {
            fireEvent.click(button)
          }
        }

        await waitFor(() => expect(visited.filter(where => where.startsWith('/projects'))).toEqual([]))
      }

      expect(labels).toBeGreaterThan(1)
    }
  )
})
