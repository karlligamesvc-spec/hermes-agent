import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import {
  activateSidebarNavigation,
  BUSINESS_HISTORY_ROUTE,
  BUSINESS_NAV_IDS,
  BUSINESS_SIDEBAR_NAV_CONTRACT,
  isBusinessNavigationContract,
  isBusinessWorkspaceEnabled,
  LEGACY_SIDEBAR_NAV_CONTRACT,
  runSessionSearchShortcut,
  visibleSidebarNavItems
} from '@/store/business-workspace'
import { mainComposerScope } from '@/store/composer'
import { $cronJobs } from '@/store/cron'
import { setSessions, setSessionsLoading } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { TasksView } from '../tasks'

import { BusinessGoalLauncher } from './goal-launcher'
import { BusinessStartHome } from './start-home'
import { BusinessStartShelf } from './start-shelf'

import { ProjectsView, WorkflowsView } from '.'

function LocationProbe() {
  const location = useLocation()

  const routeDrawerState = location.state as
    | {
        businessGoalDraft?: string
        businessWorkflowSlug?: string
        routeDrawer?: { backgroundLocation?: { pathname?: string } }
      }
    | null

  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <output data-testid="route-drawer-source">{routeDrawerState?.routeDrawer?.backgroundLocation?.pathname ?? ''}</output>
      <output data-testid="business-goal-draft">{routeDrawerState?.businessGoalDraft ?? ''}</output>
      <output data-testid="business-workflow-slug">{routeDrawerState?.businessWorkflowSlug ?? ''}</output>
    </>
  )
}

function domainRun(id: string, triggerRef: string) {
  return {
    attempt: 1,
    completedAt: null,
    createdAt: '2026-08-27T10:00:00Z',
    errorCode: null,
    errorMessage: null,
    executorType: 'hermes',
    id,
    maxAttempts: 2,
    startedAt: null,
    status: 'queued',
    triggerRef,
    updatedAt: '2026-08-27T10:00:00Z'
  }
}

describe('hc-685 business workspace identity', () => {
  beforeEach(() => {
    setSessions([])
    setSessionsLoading(false)
    $sessionStates.set({})
    $cronJobs.set([])
    mainComposerScope.clear()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        api: vi.fn(async () => ({ errors: [], has_more_by_profile: {}, offset: 0, sessions: [], total: 0 })),
        openExternal: vi.fn(async () => undefined)
      }
    })
  })

  it('exposes the seven outcome-oriented destinations in order', () => {
    expect(BUSINESS_NAV_IDS).toEqual([
      'start',
      'projects',
      'workflows',
      'scheduled-runs',
      'deliverables',
      'assistant',
      'history'
    ])
    expect(isBusinessNavigationContract([...BUSINESS_NAV_IDS, 'skills'])).toBe(false)
    expect(isBusinessNavigationContract(BUSINESS_NAV_IDS)).toBe(true)
  })

  it('defaults on in a fresh environment and retains a rollback seam', () => {
    expect(isBusinessWorkspaceEnabled({ getItem: vi.fn(() => null) })).toBe(true)
    expect(isBusinessWorkspaceEnabled({ getItem: vi.fn(() => '0') })).toBe(false)
  })

  it('preserves the exact origin/main six-row rollback contract, including keybinds', () => {
    expect(LEGACY_SIDEBAR_NAV_CONTRACT).toEqual([
      { id: 'new-session', action: 'new-session', keybindActionId: 'session.new' },
      { id: 'search', route: '/search', keybindActionId: 'session.focusSearch' },
      { id: 'cron', route: '/cron', keybindActionId: 'nav.cron' },
      { id: 'tasks', route: '/tasks' },
      { id: 'skills', route: '/skills', keybindActionId: 'nav.skills' },
      { id: 'artifacts', route: '/artifacts', keybindActionId: 'nav.artifacts' }
    ])
  })

  it('uses one canonical route for History clicks and the search shortcut', () => {
    const history = BUSINESS_SIDEBAR_NAV_CONTRACT.find(item => item.id === 'history')
    const clickNavigate = vi.fn()
    const shortcutNavigate = vi.fn()
    const focus = vi.fn()

    expect(history).toBeDefined()
    activateSidebarNavigation(history!, clickNavigate, vi.fn())
    runSessionSearchShortcut(shortcutNavigate, focus)

    expect(BUSINESS_HISTORY_ROUTE).toBe('/history')
    expect(clickNavigate).toHaveBeenCalledWith(BUSINESS_HISTORY_ROUTE)
    expect(shortcutNavigate).toHaveBeenCalledWith(BUSINESS_HISTORY_ROUTE)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('keeps contributed rows out of business mode and restores them in rollback mode', () => {
    const contributed = [{ id: 'kanban', route: '/kanban' }]

    expect(visibleSidebarNavItems(BUSINESS_SIDEBAR_NAV_CONTRACT, contributed, true)).toHaveLength(7)
    expect(visibleSidebarNavItems(LEGACY_SIDEBAR_NAV_CONTRACT, contributed, false)).toHaveLength(7)
    expect(visibleSidebarNavItems(LEGACY_SIDEBAR_NAV_CONTRACT, contributed, false).at(-1)).toEqual(contributed[0])
  })

  it('moves a workflow selection to the editable Start goal without starting it', async () => {
    const insert = vi.fn()
    window.addEventListener('hermes:composer-insert', insert)

    render(
      <MemoryRouter initialEntries={['/workflows']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <WorkflowsView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.queryByText(/Skill|MCP|模型/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /从市场机会到上架素材/ }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(screen.getByTestId('business-goal-draft').textContent).toContain('分析美国宠物用品市场')
    expect(screen.getByTestId('business-workflow-slug').textContent).toBe('market-launch')
    expect(insert).not.toHaveBeenCalled()
    window.removeEventListener('hermes:composer-insert', insert)
  })

  it('keeps the standalone Start shelf fallback on the real Composer seam', async () => {
    const insert = vi.fn()
    window.addEventListener('hermes:composer-insert', insert)

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: /Market opportunity to launch assets/ }))

    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('location').textContent).toBe('/')
    window.removeEventListener('hermes:composer-insert', insert)
  })

  it('restores a routed workflow choice into the editable Start goal and returns focus', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/',
            state: {
              businessGoalDraft: 'stale copy must not override the approved prompt',
              businessWorkflowSlug: 'competitor-monitoring'
            }
          }
        ]}
      >
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartHome />
        </I18nProvider>
      </MemoryRouter>
    )

    const goal = screen.getByRole('textbox', { name: 'Business goal' })

    await waitFor(() => expect(window.document.activeElement).toBe(goal))
    expect((goal as HTMLTextAreaElement).value).toContain('Monitor my key competitors')
  })

  it('stages a Start workflow in the canonical goal field before real submission', async () => {
    const insert = vi.fn()
    const submit = vi.fn(async () => true)
    window.addEventListener('hermes:composer-insert', insert)

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <BusinessStartHome onSubmitGoal={submit} />
        </I18nProvider>
      </MemoryRouter>
    )

    const goal = screen.getByRole('textbox', { name: '业务目标' })
    fireEvent.click(screen.getByRole('button', { name: /从市场机会到上架素材/ }))

    await waitFor(() =>
      expect((goal as HTMLTextAreaElement).value).toBe('分析美国宠物用品市场，并生成选品报告和上架素材')
    )
    expect(window.document.activeElement).toBe(goal)
    expect(insert).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith('分析美国宠物用品市场，并生成选品报告和上架素材'))
    await waitFor(() => expect((goal as HTMLTextAreaElement).value).toBe(''))
    window.removeEventListener('hermes:composer-insert', insert)
  })

  it('starts the selected workflow through the authenticated domain bridge and opens its real Run', async () => {
    const submit = vi.fn(async () => true)
    const access = vi.fn(async () => ({ available: true }))

    const startGoal = vi.fn(async () => ({
      ok: true,
      run: domainRun('run-795', '分析美国宠物用品市场，并生成选品报告和上架素材')
    }))

    window.hermesDesktop!.workflowDomain = {
      access,
      cancelRun: vi.fn(),
      getRun: vi.fn(),
      reviewDeliverable: vi.fn(),
      startGoal
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <BusinessStartHome onSubmitGoal={submit} />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: /从市场机会到上架素材/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '业务目标' }), {
      target: { value: '分析美国宠物用品市场，并生成选品报告和上架素材（已编辑）' }
    })
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workflow-runs/run-795'))
    expect(screen.getByTestId('route-drawer-source').textContent).toBe('/')
    expect(access).toHaveBeenCalledTimes(1)
    expect(startGoal).toHaveBeenCalledWith({
      objective: '分析美国宠物用品市场，并生成选品报告和上架素材（已编辑）',
      starter: {
        description: '数据采集、机会分析、定位与生产',
        id: 'market-launch',
        name: '从市场机会到上架素材',
        slug: 'market-launch',
        version: 1
      }
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('renders one canonical Project summary read and reopens its current Run', async () => {
    const listProjects = vi.fn(async () => ({
      items: [
        {
          createdAt: '2026-09-01T10:00:00Z',
          id: 'project-1',
          name: '美国宠物用品上架',
          objective: '完成选品并准备上架素材',
          status: 'active',
          summary: {
            attention: 'none' as const,
            currentRunId: 'run-project-1',
            currentRunStatus: 'running',
            currentStepTitle: null,
            deliverableCount: 2,
            stepCompleted: 0,
            stepTotal: 0
          },
          updatedAt: '2026-09-04T10:00:00Z'
        }
      ],
      nextCursor: null,
      ok: true,
      total: 1
    }))

    window.hermesDesktop!.workflowDomain = {
      access: vi.fn(async () => ({ available: true })),
      cancelRun: vi.fn(),
      getRun: vi.fn(),
      listProjects,
      reviewDeliverable: vi.fn(),
      startGoal: vi.fn()
    }

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ProjectsView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('美国宠物用品上架')).toBeTruthy())
    expect(listProjects).toHaveBeenCalledWith({ limit: 50 })
    expect(screen.getByText('Hermes 正在执行')).toBeTruthy()
    expect(screen.queryByText(/0 \/ 0/)).toBeNull()
    expect(screen.getByText('2 个交付物')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /美国宠物用品上架/ }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workflow-runs/run-project-1'))
    expect(screen.getByTestId('route-drawer-source').textContent).toBe('/projects')
  })

  it('shows only real channel capabilities as Start data sources', async () => {
    window.hermesDesktop!.workflowDomain = {
      access: vi.fn(async () => ({ available: true })),
      cancelRun: vi.fn(),
      getRun: vi.fn(),
      listProjects: vi.fn(async () => ({ items: [], ok: true, total: 0 })),
      reviewDeliverable: vi.fn(),
      startGoal: vi.fn()
    }
    Object.assign(window.hermesDesktop!, {
      imEntry: {
        list: vi.fn(async () => ({ channels: [{ boundAt: 1, channelId: 'feishu', domain: 'feishu.cn' }] }))
      }
    })

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Available data sources')).toBeTruthy())
    expect(screen.getByText('Feishu / Lark')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.queryByText('DingTalk')).toBeNull()
  })

  it('uses the live six-path catalog and reads saved workflows without starting a Run', async () => {
    const catalog = [
      ['market-launch', 'cross_border_launch', true],
      ['geo-brand-audit', 'geo_brand_audit', true],
      ['content-review', 'content_review', true],
      ['competitor-monitoring', 'competitor_monitoring', false],
      ['review-insights', 'review_insights', false],
      ['business-review', 'business_review', false]
    ].map(([id, businessPath, recommended], index) => ({
      businessPath: String(businessPath),
      id: String(id),
      position: index + 1,
      recommended: Boolean(recommended),
      slug: String(id),
      version: 1
    }))

    const getCatalog = vi.fn(async () => ({ items: catalog, ok: true, version: 'workflow-catalog/v1' }))

    const listWorkflows = vi.fn(async () => ({
      items: [
        {
          createdAt: '2026-09-04T10:00:00Z',
          description: '真实工作流',
          id: 'workflow-1',
          name: '我的选品流程',
          projectId: 'project-1',
          slug: 'market-launch',
          status: 'active',
          updatedAt: '2026-09-04T10:00:00Z',
          version: 2
        }
      ],
      ok: true
    }))

    const startGoal = vi.fn()

    window.hermesDesktop!.workflowDomain = {
      access: vi.fn(async () => ({ available: true })),
      cancelRun: vi.fn(),
      getCatalog,
      getRun: vi.fn(),
      listWorkflows,
      reviewDeliverable: vi.fn(),
      startGoal
    }

    render(
      <MemoryRouter initialEntries={['/workflows']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <WorkflowsView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('我的选品流程')).toBeTruthy())
    expect(getCatalog).toHaveBeenCalledTimes(1)
    expect(listWorkflows).toHaveBeenCalledWith({ limit: 50 })
    expect(screen.getByText('版本 2')).toBeTruthy()
    expect(screen.queryByText(/DSH|DeepSeek/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /竞品监控/ }))

    await waitFor(() => expect(screen.getByTestId('business-workflow-slug').textContent).toBe('competitor-monitoring'))
    expect(startGoal).not.toHaveBeenCalled()
  })

  it('falls back to the existing chat submission when workflow-domain access is dark', async () => {
    const submit = vi.fn(async () => true)
    const startGoal = vi.fn()
    window.hermesDesktop!.workflowDomain = {
      access: vi.fn(async () => ({ available: false })),
      cancelRun: vi.fn(),
      getRun: vi.fn(),
      reviewDeliverable: vi.fn(),
      startGoal
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <BusinessStartHome onSubmitGoal={submit} />
        </I18nProvider>
      </MemoryRouter>
    )

    const goal = screen.getByRole('textbox', { name: '业务目标' })
    fireEvent.change(goal, { target: { value: '继续走原有聊天链路' } })
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))

    await waitFor(() => expect(submit).toHaveBeenCalledWith('继续走原有聊天链路'))
    expect(startGoal).not.toHaveBeenCalled()
  })

  it('maps a freeform goal to a neutral workflow instead of silently using the first shelf template', async () => {
    const startGoal = vi.fn(async () => ({
      ok: true,
      run: domainRun('run-freeform', 'Audit my current launch plan')
    }))

    window.hermesDesktop!.workflowDomain = {
      access: vi.fn(async () => ({ available: true })),
      cancelRun: vi.fn(),
      getRun: vi.fn(),
      reviewDeliverable: vi.fn(),
      startGoal
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartHome />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    const goal = screen.getByRole('textbox', { name: 'Business goal' })
    fireEvent.change(goal, { target: { value: 'Audit my current launch plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workflow-runs/run-freeform'))
    expect(startGoal).toHaveBeenCalledWith({
      objective: 'Audit my current launch plan',
      starter: {
        description: 'Describe the goal. APEX organizes the evidence, moves the work forward, and delivers the result.',
        id: 'desktop-goal',
        name: 'What business should we move forward today?',
        slug: 'desktop-goal',
        version: 1
      }
    })
  })

  it('preserves the goal and does not duplicate-submit when a gated Run creation fails', async () => {
    const submit = vi.fn(async () => true)
    const attachment = { id: 'launch-brief', kind: 'file' as const, label: 'launch-brief.pdf' }

    mainComposerScope.add(attachment)
    window.hermesDesktop!.workflowDomain = {
      access: vi.fn(async () => ({ available: true })),
      cancelRun: vi.fn(),
      getRun: vi.fn(),
      reviewDeliverable: vi.fn(),
      startGoal: vi.fn(async () => ({ code: 'request_failed' as const, ok: false }))
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <BusinessStartHome onSubmitGoal={submit} />
        </I18nProvider>
      </MemoryRouter>
    )

    const goal = screen.getByRole('textbox', { name: '业务目标' })
    fireEvent.change(goal, { target: { value: '保留这个目标' } })
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('真实工作流启动失败'))
    expect((goal as HTMLTextAreaElement).value).toBe('保留这个目标')
    expect(mainComposerScope.$attachments.get()).toEqual([attachment])
    expect(submit).not.toHaveBeenCalled()
  })

  it('submits a trimmed business goal through the caller-owned chat seam', async () => {
    const submit = vi.fn(async () => true)

    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <BusinessGoalLauncher onSubmit={submit} />
      </I18nProvider>
    )

    const goal = screen.getByRole('textbox', { name: '业务目标' })
    fireEvent.change(goal, { target: { value: '  分析美国宠物用品市场  ' } })
    fireEvent.keyDown(goal, { key: 'Enter' })

    await waitFor(() => expect(submit).toHaveBeenCalledWith('分析美国宠物用品市场'))
    expect((goal as HTMLTextAreaElement).value).toBe('')
  })

  it('preserves the draft for a rejected goal and leaves Shift+Enter to the textarea', async () => {
    const submit = vi.fn(async () => false)

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <BusinessGoalLauncher onSubmit={submit} />
      </I18nProvider>
    )

    const goal = screen.getByRole('textbox', { name: 'Business goal' })
    fireEvent.change(goal, { target: { value: 'Keep this draft' } })
    fireEvent.keyDown(goal, { key: 'Enter', shiftKey: true })
    expect(submit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith('Keep this draft'))
    expect((goal as HTMLTextAreaElement).value).toBe('Keep this draft')
  })

  it('focuses the canonical goal field from the prototype-aligned top action', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <BusinessStartHome />
        </I18nProvider>
      </MemoryRouter>
    )

    const goal = screen.getByRole('textbox', { name: '业务目标' })
    expect(window.document.activeElement).not.toBe(goal)

    fireEvent.click(screen.getByRole('button', { name: '开始一个目标' }))
    expect(window.document.activeElement).toBe(goal)
  })

  it('shows and restores recent work only from real sessions', async () => {
    setSessions([
      {
        id: 'real-tip-2',
        _lineage_root_id: 'real-root-2',
        ended_at: null,
        input_tokens: 0,
        is_active: false,
        last_active: 30,
        message_count: 3,
        model: null,
        output_tokens: 0,
        preview: 'Evidence-backed market summary',
        source: 'desktop',
        started_at: 20,
        title: 'Real market review',
        tool_call_count: 2
      }
    ])

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.queryByText('美国宠物用品机会分析')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Real market review/ }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/real-tip-2'))
  })

  it('keeps start-page loading distinct from a proven real-session empty state', () => {
    setSessionsLoading(true)

    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.getByText('Loading recent conversations…')).toBeTruthy()
    expect(screen.queryByText('No real conversations yet. Start a chat to create the first one.')).toBeNull()

    act(() => setSessionsLoading(false))
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.getByText('No real conversations yet. Start a chat to create the first one.')).toBeTruthy()
  })

  it('shows running tasks and deliverables on Start only from their real scheduler and transcript exits', async () => {
    const artifactSource = {
      id: 'artifact-source',
      ended_at: null,
      input_tokens: 0,
      is_active: false,
      last_active: 40,
      message_count: 2,
      model: null,
      output_tokens: 0,
      preview: 'Delivered the market report',
      source: 'desktop',
      started_at: 30,
      title: 'Market evidence',
      tool_call_count: 1
    }

    const run = {
      ...artifactSource,
      id: 'run-1',
      preview: 'Collect competitor evidence',
      source: 'cron',
      title: 'Competitor scan'
    }

    $cronJobs.set([
      {
        enabled: true,
        id: 'job-1',
        name: 'Competitor scan',
        schedule: { kind: 'once' },
        state: 'running'
      }
    ])

    window.hermesDesktop!.api = vi.fn(async request => {
      if (request.path.startsWith('/api/profiles/sessions')) {
        return { errors: [], has_more_by_profile: {}, offset: 0, sessions: [artifactSource], total: 1 }
      }

      if (request.path.startsWith('/api/cron/jobs/job-1/runs')) {
        return { runs: [run] }
      }

      if (request.path.startsWith('/api/sessions/run-1/messages')) {
        return {
          messages: [
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'todo-1',
                  name: 'todo',
                  args: { todos: [{ id: 'one', content: 'Collect evidence', status: 'in_progress' }] }
                }
              ]
            },
            { role: 'tool', content: '{"ok":true}', tool_call_id: 'todo-1', tool_name: 'todo' }
          ]
        }
      }

      if (request.path.startsWith('/api/sessions/artifact-source/messages')) {
        return { messages: [{ role: 'assistant', content: 'Saved /tmp/market-report.pdf', timestamp: 100 }] }
      }

      throw new Error(`Unexpected request: ${request.path}`)
    }) as never

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText(/Collect evidence/)).toBeTruthy())
    expect(screen.getByText('market-report.pdf')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Competitor scan/ }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tasks?task=job-1'))

    fireEvent.click(screen.getByRole('button', { name: /market-report.pdf/ }))
    await waitFor(() =>
      expect(window.hermesDesktop!.openExternal).toHaveBeenCalledWith(expect.stringContaining('market-report.pdf'))
    )
    expect(screen.getByTestId('location').textContent).toBe('/tasks?task=job-1')
  })

  it('does not turn a Start evidence failure into a false empty-deliverables claim', async () => {
    window.hermesDesktop!.api = vi.fn(async () => {
      throw new Error('evidence source unavailable')
    }) as never

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <BusinessStartShelf />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(
        screen.getByText(
          'Some evidence could not be read. The original conversations, Tasks, and Artifacts views remain available.'
        )
      ).toBeTruthy()
    )
    expect(screen.queryByText('No file, image, or link deliverables were found in recent conversations.')).toBeNull()
  })

  it('keeps the existing v0.20 task surface reachable from the real-work summary', async () => {
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ProjectsView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByRole('button', { name: '查看任务进度' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看任务进度' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tasks'))
  })

  it('selects the exact finished task named by a real-work deep link', async () => {
    $cronJobs.set([
      { enabled: true, id: 'running-job', name: 'Running scan', schedule: { kind: 'once' }, state: 'running' },
      { enabled: false, id: 'done-job', name: 'Finished report', schedule: { kind: 'once' }, state: 'completed' }
    ])

    const { container } = render(
      <MemoryRouter initialEntries={['/tasks?task=done-job']}>
        <I18nProvider configClient={null} initialLocale="en">
          <TasksView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByRole('button', { name: /Done/ }).getAttribute('data-active')).toBe('true'))
    expect(container.querySelector('[data-task-row="done-job"]')?.className).toContain('bg-accent')
    expect(screen.getAllByText('Finished report').length).toBeGreaterThan(1)
  })

  it('opens the current compressed-session tip from real history, not its lineage root', async () => {
    setSessions([
      {
        id: 'tip-1',
        _lineage_root_id: 'root-1',
        ended_at: null,
        input_tokens: 0,
        is_active: false,
        last_active: 10,
        message_count: 2,
        model: null,
        output_tokens: 0,
        preview: 'Latest projected work',
        source: 'desktop',
        started_at: 1,
        title: 'Compressed conversation',
        tool_call_count: 1
      }
    ])

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: /Compressed conversation/ }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tip-1'))
  })

  it('keeps initial evidence loading distinct from a proven empty workspace', () => {
    const pending = new Promise(() => undefined)
    window.hermesDesktop!.api = vi.fn(async () => pending) as never

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.getByText('Reading evidence from recent conversations…')).toBeTruthy()
    expect(screen.queryByText('Start with a real business task')).toBeNull()
  })

  it('shows a hard evidence-read failure instead of claiming the workspace is empty', async () => {
    window.hermesDesktop!.api = vi.fn(async () => {
      throw new Error('profile database locked')
    }) as never

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Recent evidence is unavailable')).toBeTruthy())
    expect(screen.queryByText('Start with a real business task')).toBeNull()
  })

  it('shows the start-chat empty state only after the real source returns zero data', async () => {
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Start with a real business task')).toBeTruthy())
    expect(screen.queryByText('Recent evidence is unavailable')).toBeNull()
  })

  it('replaces a previously empty snapshot with an explicit hard failure when refresh fails', async () => {
    window.hermesDesktop!.api = vi
      .fn()
      .mockResolvedValueOnce({ errors: [], has_more_by_profile: {}, offset: 0, sessions: [], total: 0 })
      .mockRejectedValueOnce(new Error('refresh failed')) as never

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Start with a real business task')).toBeTruthy())

    act(() => {
      setSessions([
        {
          id: 'unused-empty-row',
          ended_at: null,
          input_tokens: 0,
          is_active: false,
          last_active: 20,
          message_count: 0,
          model: null,
          output_tokens: 0,
          preview: null,
          source: 'desktop',
          started_at: 20,
          title: null,
          tool_call_count: 0
        }
      ])
    })

    await waitFor(() => expect(screen.getByText('Recent evidence is unavailable')).toBeTruthy())
    expect(screen.queryByText('Start with a real business task')).toBeNull()
  })

  it('does not claim zero artifacts when a source session transcript is unreadable', async () => {
    const source = {
      id: 'source-1',
      ended_at: null,
      input_tokens: 0,
      is_active: false,
      last_active: 30,
      message_count: 2,
      model: null,
      output_tokens: 0,
      preview: 'Delivered a report',
      source: 'desktop',
      started_at: 20,
      title: 'Source conversation',
      tool_call_count: 1
    }

    window.hermesDesktop!.api = vi.fn(async request => {
      if (request.path.startsWith('/api/profiles/sessions')) {
        return { errors: [], has_more_by_profile: {}, offset: 0, sessions: [source], total: 1 }
      }

      throw new Error('transcript unreadable')
    }) as never

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(
        screen.getAllByText(
          'Some evidence could not be read. The original conversations, Tasks, and Artifacts views remain available.'
        ).length
      ).toBeGreaterThan(0)
    )
    expect(screen.queryByText('No file, image, or link deliverables were found in recent conversations.')).toBeNull()
    expect(screen.queryByText('Start with a real business task')).toBeNull()
  })

  it('marks the specific task row unavailable when its real run state cannot be read', async () => {
    $cronJobs.set([{ enabled: true, id: 'job-1', name: 'Competitor report', schedule: { kind: 'once' } }])
    window.hermesDesktop!.api = vi.fn(async () => {
      throw new Error('task run unavailable')
    }) as never

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(
        screen.getByText('Progress is temporarily unreadable. Open Tasks to retry the authoritative view.')
      ).toBeTruthy()
    )
    expect(
      screen.queryByText('No plan or latest output has been recorded yet. Open Tasks for the full run state.')
    ).toBeNull()
  })

  it('moves a task row from loading to proven no-record only after the real read completes', async () => {
    $cronJobs.set([{ enabled: true, id: 'job-1', name: 'Competitor report', schedule: { kind: 'once' } }])
    let resolveRuns!: (value: { runs: [] }) => void

    const pendingRuns = new Promise<{ runs: [] }>(resolve => {
      resolveRuns = resolve
    })

    window.hermesDesktop!.api = vi.fn(async request => {
      if (request.path.startsWith('/api/profiles/sessions')) {
        return { errors: [], has_more_by_profile: {}, offset: 0, sessions: [], total: 0 }
      }

      return pendingRuns
    }) as never

    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="en">
          <ProjectsView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Reading task progress…')).toBeTruthy())
    expect(
      screen.queryByText('No plan or latest output has been recorded yet. Open Tasks for the full run state.')
    ).toBeNull()

    await act(async () => {
      resolveRuns({ runs: [] })
      await pendingRuns
    })

    await waitFor(() =>
      expect(
        screen.getByText('No plan or latest output has been recorded yet. Open Tasks for the full run state.')
      ).toBeTruthy()
    )
    expect(screen.queryByText('Reading task progress…')).toBeNull()
  })
})
