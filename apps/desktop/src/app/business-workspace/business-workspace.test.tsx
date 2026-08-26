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
import { $cronJobs } from '@/store/cron'
import { setSessions, setSessionsLoading } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { BusinessStartShelf } from './start-shelf'

import { ProjectsView, WorkflowsView } from '.'

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

describe('hc-685 business workspace identity', () => {
  beforeEach(() => {
    setSessions([])
    setSessionsLoading(false)
    $sessionStates.set({})
    $cronJobs.set([])
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        api: vi.fn(async () => ({ errors: [], has_more_by_profile: {}, offset: 0, sessions: [], total: 0 }))
      }
    })
  })

  it('exposes the seven outcome-oriented destinations in order', () => {
    expect(BUSINESS_NAV_IDS).toEqual([
      'new-session',
      'projects',
      'workflows',
      'cron',
      'artifacts',
      'accounts',
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

    expect(BUSINESS_HISTORY_ROUTE).toBe('/search')
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

  it('moves a workflow goal into the real composer seam without creating domain data', async () => {
    const insert = vi.fn()
    window.addEventListener('hermes:composer-insert', insert)

    render(
      <MemoryRouter initialEntries={['/workflows']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <WorkflowsView />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.queryByText(/Skill|MCP|模型/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /从市场机会到上架素材/ }))

    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1))
    window.removeEventListener('hermes:composer-insert', insert)
  })

  it('uses the real chat composer for a start-page workflow without creating a project route', async () => {
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
