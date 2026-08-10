import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

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

import { ProjectsView, WorkflowsView } from '.'

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

describe('hc-685 business workspace identity', () => {
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

  it('moves a workflow goal into the real composer seam without creating domain data', () => {
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

    return new Promise<void>(resolve => {
      window.setTimeout(() => {
        expect(insert).toHaveBeenCalledTimes(1)
        window.removeEventListener('hermes:composer-insert', insert)
        resolve()
      }, 20)
    })
  })

  it('keeps the existing v0.20 task surface reachable from Projects', () => {
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ProjectsView />
          <LocationProbe />
        </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: '查看任务进度' }))
    expect(screen.getByTestId('location').textContent).toBe('/tasks')
  })
})
