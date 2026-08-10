import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import {
  BUSINESS_NAV_IDS,
  isBusinessNavigationContract,
  isBusinessWorkspaceEnabled
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
