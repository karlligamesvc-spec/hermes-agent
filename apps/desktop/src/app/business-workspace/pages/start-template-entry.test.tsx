import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { WorkflowDomainBridge } from '../api/types'

import { BusinessStartHome } from './start-page'
import { WorkflowsView } from './workflows-page'

function Workspace() {
  const location = useLocation()

  return <>
    <div hidden={location.pathname !== '/'}><BusinessStartHome onSubmitGoal={async () => false} /></div>
    {location.pathname === '/workflows' && <WorkflowsView />}
    <output data-testid="location">{location.pathname}</output>
    <output data-testid="selection">{JSON.stringify(location.state)}</output>
  </>
}

function installBridge() {
  const bridge = {
    access: vi.fn(async () => ({ available: true })),
    cancelRun: vi.fn(), createProject: vi.fn(), createWorkflow: vi.fn(), getRun: vi.fn(), reviewDeliverable: vi.fn(),
    getCatalog: vi.fn(async () => ({ items: [{
      businessPath: 'research', id: 'competitor-monitoring', position: 1, recommended: true,
      slug: 'competitor-monitoring', version: 3
    }], ok: true, version: 'workflow-catalog/v1' })),
    getVideoCatalog: vi.fn(async () => ({ items: [], ok: true, version: 'video/v1' })),
    listProjects: vi.fn(async () => ({ items: [], ok: true, total: 0 })),
    listWorkflows: vi.fn(async () => ({ items: [], ok: true })),
    startGoal: vi.fn<WorkflowDomainBridge['startGoal']>(async () => ({ ok: false, run: undefined as undefined | { id: string } }))
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { workflowDomain: bridge } })

  return bridge
}

beforeEach(() => { installBridge() })
afterEach(() => { Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined }) })

async function chooseFromActualStart(brief: string) {
  render(<MemoryRouter initialEntries={['/']}><I18nProvider configClient={null} initialLocale="zh">
    <Workspace />
  </I18nProvider></MemoryRouter>)
  const goal = screen.getByRole('textbox', { name: '业务目标' })
  fireEvent.change(goal, { target: { value: brief } })
  fireEvent.click(screen.getByRole('button', { name: '选择工作流' }))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workflows'))
  fireEvent.click(await screen.findByRole('button', { name: /竞品监控/ }))
  const dialog = screen.getByRole('dialog', { name: '竞品监控' })
  expect(within(dialog).queryByRole('button', { name: '加入已有项目' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '使用这个工作流' }))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))

  return goal as HTMLTextAreaElement
}

describe('actual Start template-selection entry', () => {
  it('preserves the typed brief and catalog identity without writing until explicit submit, then retains a rejected goal', async () => {
    const bridge = installBridge()
    const goal = await chooseFromActualStart('用户已写好的目标')
    expect(goal.value).toBe('用户已写好的目标')
    expect(JSON.parse(screen.getByTestId('selection').textContent!)).toMatchObject({
      businessGoalDraft: '用户已写好的目标', businessStartSelection: true,
      businessWorkflowId: 'competitor-monitoring', businessWorkflowSlug: 'competitor-monitoring',
      businessWorkflowVersion: 3, businessWorkflowCatalogProvenance: 'production'
    })
    expect(bridge.createProject).not.toHaveBeenCalled()
    expect(bridge.createWorkflow).not.toHaveBeenCalled()
    expect(bridge.startGoal).not.toHaveBeenCalled()
    const submit = screen.getByRole('button', { name: '开始执行' })
    fireEvent.click(submit)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目标草稿已保留'))
    expect(goal.value).toBe('用户已写好的目标')
    expect(submit.hasAttribute('disabled')).toBe(false)
    expect(bridge.startGoal).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.stringMatching(/^desktop:/),
      objective: '用户已写好的目标',
      starter: expect.objectContaining({ id: 'competitor-monitoring', slug: 'competitor-monitoring', version: 3 })
    })
    bridge.startGoal.mockResolvedValueOnce({ ok: true, run: { id: 'run-confirmed' } })
    fireEvent.click(submit)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('run-confirmed'))
    expect(bridge.startGoal).toHaveBeenCalledTimes(2)
    expect(bridge.startGoal.mock.calls[0]?.[0].idempotencyKey).toBe(bridge.startGoal.mock.calls[1]?.[0].idempotencyKey)
  })

  it('returns from changing a template with the edited brief and prior selection intact', async () => {
    const bridge = installBridge()
    const goal = await chooseFromActualStart('原始目标')
    fireEvent.change(goal, { target: { value: '已经编辑的目标' } })
    fireEvent.click(screen.getByRole('button', { name: '更换工作流' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workflows'))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(goal.value).toBe('已经编辑的目标')
    expect(JSON.parse(screen.getByTestId('selection').textContent!)).toMatchObject({
      businessWorkflowId: 'competitor-monitoring', businessWorkflowVersion: 3,
      businessWorkflowCatalogProvenance: 'production'
    })
    expect(bridge.startGoal).not.toHaveBeenCalled()
  })
})
