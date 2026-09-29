import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'

import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import {
  cancelWorkflowRun, completeWorkflowProject, createWorkflowDefinition, createWorkflowProject,
  reopenWorkflowProject, retryWorkflowRunStep, reviewWorkflowDeliverable, startExistingWorkflowRun,
  startWorkflowGoal, updateWorkflowProject
} from './adapters'
import { workflowDomainChanged } from './read-revision'
import type { WorkflowProject } from './types'

vi.mock('./read-revision', () => ({ workflowDomainChanged: vi.fn() }))

const original = $authState.get()

const project: WorkflowProject = {
  createdAt: '2026-09-29T00:00:00Z', id: 'project', name: 'Project', objective: 'Objective',
  status: 'active', updatedAt: '2026-09-29T00:00:00Z'
}

const starter: BusinessWorkflowStarter = {
  businessPath: 'general', icon: 'chart', id: 'starter', prompt: 'Objective', recommended: false,
  slug: 'desktop-goal', summary: 'Objective', title: 'Starter', version: 1
}

const writes = [
  ['startGoal', () => startWorkflowGoal('Objective', starter)],
  ['createWorkflow', () => createWorkflowDefinition('Objective', starter, project.id)],
  ['startRun', () => startExistingWorkflowRun('Objective', 'workflow')],
  ['createProject', () => createWorkflowProject({ name: 'Updated', objective: 'Objective' })],
  ['updateProject', () => updateWorkflowProject({ name: 'Updated', objective: 'Objective', projectId: project.id })],
  ['completeProject', () => completeWorkflowProject(project.id)],
  ['reopenProject', () => reopenWorkflowProject(project.id)],
  ['cancelRun', () => cancelWorkflowRun('run')],
  ['retryRunStep', () => retryWorkflowRunStep('run', 'step')],
  ['reviewDeliverable', () => reviewWorkflowDeliverable('deliverable', 'approved')]
] as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })

  return { promise, resolve }
}

const acknowledged = { item: project, ok: true, run: { id: 'run' }, workflow: { id: 'workflow' } }

function installBridge() {
  const mutation = () => Promise.resolve(acknowledged)

  const bridge = {
    access: vi.fn(async () => ({ available: true })),
    cancelRun: vi.fn(mutation), completeProject: vi.fn(mutation), createProject: vi.fn(mutation),
    createWorkflow: vi.fn(mutation), getRun: vi.fn(async () => ({ ok: false })),
    reopenProject: vi.fn(mutation), retryRunStep: vi.fn(mutation), reviewDeliverable: vi.fn(mutation),
    startGoal: vi.fn(mutation), startRun: vi.fn(mutation), updateProject: vi.fn(mutation)
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { workflowDomain: bridge } })

  return bridge
}

function expectRejected(outcome: Awaited<ReturnType<(typeof writes)[number][1]>>) {
  if (typeof outcome === 'boolean') {expect(outcome).toBe(false)}
  else {expect(['failed', 'unavailable']).toContain(outcome.mode)}

  expect(workflowDomainChanged).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  $authState.set({ ...original, accountId: 'owner-a', enabled: true, status: 'signed-in' })
})
afterEach(() => {
  $authState.set(original)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })
})

describe('Workflow writes retain the initiating account across awaits', () => {
  it.each(writes.slice(0, 7))('%s stops before IPC when account changes during access', async (method, write) => {
    const bridge = installBridge()
    const access = deferred<{ available: boolean }>()
    bridge.access.mockImplementationOnce(() => access.promise)
    const pending = write()
    expect(bridge.access).toHaveBeenCalledOnce()
    $authState.set({ ...$authState.get(), accountId: 'owner-b' })
    access.resolve({ available: true })
    expectRejected(await pending)
    expect(bridge[method]).not.toHaveBeenCalled()
  })

  it.each(writes)('%s ignores an old account acknowledgement', async (method, write) => {
    const bridge = installBridge()
    const reply = deferred<typeof acknowledged>()
    bridge[method].mockImplementationOnce(() => reply.promise)
    const pending = write()
    await waitFor(() => expect(bridge[method]).toHaveBeenCalledOnce())
    $authState.set({ ...$authState.get(), accountId: 'owner-b' })
    reply.resolve(acknowledged)
    expectRejected(await pending)
  })

  it.each(['signed-out', 'expired', 'disabled'] as const)('suppresses a reply after the auth gate becomes %s', async status => {
    const bridge = installBridge()
    const reply = deferred<typeof acknowledged>()
    bridge.createProject.mockImplementationOnce(() => reply.promise)
    const pending = createWorkflowProject({ name: 'Project', objective: 'Objective' })
    await waitFor(() => expect(bridge.createProject).toHaveBeenCalledOnce())
    $authState.set({ ...$authState.get(), enabled: status !== 'disabled', status })
    reply.resolve(acknowledged)
    expectRejected(await pending)
  })

  it('accepts a current account reply after cosmetic profile changes', async () => {
    const bridge = installBridge()
    const reply = deferred<typeof acknowledged>()
    bridge.createProject.mockImplementationOnce(() => reply.promise)
    const pending = createWorkflowProject({ name: 'Project', objective: 'Objective' })
    await waitFor(() => expect(bridge.createProject).toHaveBeenCalledOnce())
    $authState.set({ ...$authState.get(), account: { email: 'new@example.test', name: 'New name', plan: 'Updated plan' } })
    reply.resolve(acknowledged)
    expect(await pending).toEqual({ item: project, mode: 'created' })
    expect(workflowDomainChanged).toHaveBeenCalledOnce()
  })
})
