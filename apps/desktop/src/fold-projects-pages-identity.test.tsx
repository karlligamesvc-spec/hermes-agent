// First, before any app module: the zone the shell goldens are recorded in.
import './__identity__/single-thread-shell/time-zone'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectLibraryNavigation } from '@/app/business-workspace/components/project-library-navigation'
import { AssistantWorkspaceView } from '@/app/business-workspace/pages/assistant-page'
import { WorkflowsView } from '@/app/business-workspace/pages/workflows-page'
import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { I18nProvider, type Locale } from '@/i18n'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  bodyHtml,
  CATALOG,
  DELIVERABLES,
  PROJECTS,
  SAVED_WORKFLOWS,
  seedSignedIn,
  VIDEO_CATALOG
} from './__identity__/fold-projects/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1123 identity guard (hard rule 11): the pages and the menu hc-1123 folds
 * project entries out of, with the switch off and in developer mode, on the
 * real components. The goldens in `__identity__/fold-projects/` were recorded
 * on fork main 0055de7721 before any hc-1123 code existed. A diff means the off
 * path moved: fix the code; re-record only for a change meant to reach every user.
 */

const hooks = vi.hoisted(() => ({
  deliverables: vi.fn(),
  definitions: vi.fn(),
  project: vi.fn(),
  projects: vi.fn()
}))

vi.mock('@/app/im-entry', () => ({ ImEntryView: () => <div data-testid="connections" /> }))
vi.mock('@/app/business-workspace/hooks/use-workflow-deliverables', () => ({
  useWorkflowDeliverables: hooks.deliverables
}))
vi.mock('@/app/business-workspace/hooks/use-workflow-domain-lists', async importOriginal => ({
  ...(await importOriginal<object>()),
  useVideoWorkflowCatalog: () => VIDEO_CATALOG,
  useWorkflowCatalog: () => CATALOG,
  useWorkflowDefinitions: hooks.definitions,
  useWorkflowProject: hooks.project,
  useWorkflowProjects: hooks.projects
}))
vi.mock('@/store/account-team', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadAccountTeam: vi.fn(async () => undefined)
}))

function Where() {
  const location = useLocation()

  return (
    <output data-testid="where">
      {JSON.stringify({ state: location.state, to: `${location.pathname}${location.search}${location.hash}` })}
    </output>
  )
}

function renderPage(children: ReactNode, path: string, locale: Locale = 'zh') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <Where />
        {children}
      </I18nProvider>
    </MemoryRouter>
  )
}

const where = () => JSON.parse(screen.getByTestId('where').textContent!) as { state: unknown; to: string }

const RENDERERS = {
  assistant: (locale?: Locale) => renderPage(<AssistantWorkspaceView />, '/assistant', locale),
  workflows: () => renderPage(<WorkflowsView />, '/workflows')
}

function seedReady() {
  hooks.projects.mockReturnValue({ items: PROJECTS, mode: 'ready' })
  hooks.deliverables.mockReturnValue({ state: { items: DELIVERABLES, mode: 'ready' } })
  hooks.definitions.mockReturnValue({ items: SAVED_WORKFLOWS, mode: 'ready' })
  hooks.project.mockReturnValue({ mode: 'unavailable' })
}

beforeEach(() => {
  seedSignedIn()
  seedReady()
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  vi.clearAllMocks()
})

afterAll(restoreRecordingTimeZone)

describe.each([
  ['the switch off', false, 'product'],
  ['developer mode with the switch on', true, 'technical']
] as const)('hc-1123 %s: byte-identical to main', (_label, flag, toolView) => {
  beforeEach(() => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
  })

  describe('连接助手', () => {
    it.each(['zh', 'en'] as const)('renders every section and its actions (%s)', async locale => {
      RENDERERS.assistant(locale)

      await expect(bodyHtml()).toMatchFileSnapshot(`./__identity__/fold-projects/assistant-ready.${locale}.html`)
    })

    it('renders empty lists', async () => {
      hooks.projects.mockReturnValue({ items: [], mode: 'ready' })
      hooks.deliverables.mockReturnValue({ state: { items: [], mode: 'ready' } })
      RENDERERS.assistant()

      await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-projects/assistant-empty.html')
    })

    it.each(['loading', 'failed', 'unavailable'])('renders a %s read', async mode => {
      hooks.projects.mockReturnValue({ mode })
      hooks.deliverables.mockReturnValue({ state: { mode } })
      RENDERERS.assistant()

      await expect(bodyHtml()).toMatchFileSnapshot(`./__identity__/fold-projects/assistant-${mode}.html`)
    })

    it('goes where main goes from every button', async () => {
      const out: Record<string, unknown> = {}

      for (const name of ['春季上新', '门店活动', '品牌周报', '竞品监控', '本周报告', '查看会话历史', '查看交付物']) {
        RENDERERS.assistant()
        fireEvent.click(screen.getByText(name).closest('button')!)
        out[name] = where()
        cleanup()
      }

      for (const index of [0, 1]) {
        RENDERERS.assistant()
        fireEvent.click(screen.getAllByRole('button', { name: '查看项目' })[index]!)
        out[`查看项目 ${index}`] = where()
        cleanup()
      }

      await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
        './__identity__/fold-projects/assistant-clicks.json'
      )
    })
  })

  describe('工作流库', () => {
    it('renders the tabs, the saved list and the catalog', async () => {
      RENDERERS.workflows()

      await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-projects/workflows-library.html')
    })

    it('renders the template dialog with its project buttons', async () => {
      RENDERERS.workflows()
      fireEvent.click(document.querySelector('[data-recommended-workflows] button')!)
      await screen.findByRole('dialog')

      await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-projects/workflows-dialog.html')
    })

    it('renders the page for one project, with its 返回项目', async () => {
      hooks.project.mockReturnValue({ item: PROJECTS[3], mode: 'ready' })
      renderPage(<WorkflowsView />, '/workflows?projectId=project-failed')

      await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-projects/workflows-for-project.html')
    })

    it('goes where main goes from the tabs, a saved row, 加入已有项目 and 新建项目并加入', async () => {
      const out: Record<string, unknown> = {}

      for (const name of ['我的项目', '工作流库']) {
        RENDERERS.workflows()
        fireEvent.click(screen.getByRole('button', { name }))
        out[`tab ${name}`] = where()
        cleanup()
      }

      RENDERERS.workflows()
      fireEvent.click(screen.getByText('每周看一次竞品').closest('button')!)
      out['saved row'] = where()
      cleanup()

      for (const name of ['加入已有项目', '新建项目并加入']) {
        RENDERERS.workflows()
        fireEvent.click(document.querySelector('[data-recommended-workflows] button')!)
        fireEvent.click(await screen.findByRole('button', { name }))
        out[`dialog ${name}`] = (await screen.findByRole('dialog')).querySelector('h2')?.textContent
        cleanup()
      }

      await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
        './__identity__/fold-projects/workflows-clicks.json'
      )
    })
  })

  it.each(['projects', 'workflows'] as const)('项目 | 工作流库 tabs on %s', async active => {
    renderPage(<ProjectLibraryNavigation active={active} />, `/${active}`)

    await expect(bodyHtml()).toMatchFileSnapshot(`./__identity__/fold-projects/library-tabs.${active}.html`)
  })

  describe('account menu', () => {
    async function openMenu() {
      fireEvent.pointerDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { button: 0, ctrlKey: false })
      await screen.findByRole('menuitem', { name: '设置' })
    }

    it('renders 项目 and 定时运行 in the same place', async () => {
      renderPage(<AccountPanel businessChrome />, '/chat-1')
      await openMenu()

      await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-projects/account-panel-menu.html')
    })

    it('sends every item where main sends it', async () => {
      const out: Record<string, unknown> = {}
      const onNavigateBusiness = vi.fn()

      for (const name of ['个人资料', '设置', '项目', '定时运行', '连接助手', '历史会话', '交付物']) {
        renderPage(<AccountPanel businessChrome />, '/chat-1')
        await openMenu()
        await act(async () => {
          fireEvent.click(screen.getByRole('menuitem', { name }))
        })
        out[name] = where().to
        cleanup()
      }

      for (const name of ['项目', '定时运行']) {
        renderPage(<AccountPanel businessChrome onNavigateBusiness={onNavigateBusiness} />, '/chat-1')
        await openMenu()
        await act(async () => {
          fireEvent.click(screen.getByRole('menuitem', { name }))
        })
        out[`${name} through the shell`] = onNavigateBusiness.mock.lastCall
        cleanup()
      }

      await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
        './__identity__/fold-projects/account-panel-clicks.json'
      )
    })
  })
})
