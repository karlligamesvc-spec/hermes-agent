import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cancelWorkflowRun, completeWorkflowProject, createWorkflowDefinition, createWorkflowProject,
  reopenWorkflowProject, retryWorkflowRunStep, reviewWorkflowDeliverable, startExistingWorkflowRun,
  startWorkflowGoal, updateWorkflowProject
} from '../api/adapters'
import type { WorkflowActivityItem, WorkflowDefinition, WorkflowDeliverable, WorkflowProject } from '../api/types'
import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import { useWorkflowActivity, useWorkflowDeliverables } from './use-workflow-deliverables'
import { useWorkflowDefinitions, useWorkflowProjects } from './use-workflow-domain-lists'

const project: WorkflowProject = {
  createdAt: '2026-09-29T00:00:00Z', id: 'project', name: 'Original', objective: 'Objective', status: 'active',
  updatedAt: '2026-09-29T00:00:00Z'
}

const workflow: WorkflowDefinition = {
  createdAt: project.createdAt, description: 'Objective', id: 'workflow', name: 'Original', projectId: project.id,
  slug: 'desktop-goal', status: 'active', updatedAt: project.updatedAt, version: 1
}

const deliverable: WorkflowDeliverable = {
  createdAt: project.createdAt, evidence: [], executorType: 'hermes', executorVersion: null, id: 'deliverable',
  kind: 'report', payload: { content: 'Original' }, projectId: project.id, reviews: [], runId: 'run',
  schemaVersion: 'deliverable/v1', sourceCapturedAt: null, status: 'ready', storageTarget: null, title: 'Original',
  updatedAt: project.updatedAt, verifierResult: null
}

const activity: WorkflowActivityItem = {
  happenedAt: project.updatedAt, id: 'activity', kind: 'review', status: 'approved', summary: null,
  target: { id: deliverable.id, kind: 'deliverable' }, title: 'Original'
}

const starter: BusinessWorkflowStarter = {
  businessPath: 'general', icon: 'chart', id: 'starter', prompt: 'Objective', recommended: false,
  slug: 'desktop-goal', summary: 'Objective', title: 'Starter', version: 1
}

const writes = [
  ['startGoal', () => startWorkflowGoal('Objective', starter)],
  ['createWorkflow', () => createWorkflowDefinition('Objective', starter, project.id)],
  ['startRun', () => startExistingWorkflowRun('Objective', workflow.id)],
  ['createProject', () => createWorkflowProject({ name: 'Updated', objective: 'Objective' })],
  ['updateProject', () => updateWorkflowProject({ name: 'Updated', objective: 'Objective', projectId: project.id })],
  ['completeProject', () => completeWorkflowProject(project.id)],
  ['reopenProject', () => reopenWorkflowProject(project.id)],
  ['cancelRun', () => cancelWorkflowRun('run')],
  ['retryRunStep', () => retryWorkflowRunStep('run', 'step')],
  ['reviewDeliverable', () => reviewWorkflowDeliverable(deliverable.id, 'approved')]
] as const

function installBridge(ok = true) {
  let title = 'Original'

  const mutation = async () => {
    title = 'Updated'

    return { item: { ...project, name: title }, ok, run: { id: 'run' }, workflow: { id: workflow.id } }
  }

  const bridge = {
    access: vi.fn(async () => ({ available: true })),
    cancelRun: vi.fn(mutation), completeProject: vi.fn(mutation), createProject: vi.fn(mutation),
    createWorkflow: vi.fn(mutation), getRun: vi.fn(async () => ({ ok: false })),
    listActivity: vi.fn(async () => ({ items: [{ ...activity, title }], nextCursor: null as null | string, ok: true })),
    listDeliverables: vi.fn(async () => ({ items: [{ ...deliverable, title }], nextCursor: null as null | string, ok: true })),
    listProjects: vi.fn(async () => ({ items: [{ ...project, name: title }], nextCursor: null, ok: true, total: 1 })),
    listWorkflows: vi.fn(async () => ({ items: [{ ...workflow, name: title }], ok: true })),
    reopenProject: vi.fn(mutation), retryRunStep: vi.fn(mutation), reviewDeliverable: vi.fn(mutation),
    startGoal: vi.fn(mutation), startRun: vi.fn(mutation), updateProject: vi.fn(mutation)
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { workflowDomain: bridge } })

  return bridge
}

function useMountedLists() {
  return {
    activity: useWorkflowActivity('review').state,
    deliverables: useWorkflowDeliverables({ kind: 'report', status: 'ready' }).state,
    projects: useWorkflowProjects(25, 'active'),
    workflows: useWorkflowDefinitions({ limit: 25, projectId: project.id, status: 'active' })
  }
}

function titles(lists: ReturnType<typeof useMountedLists>) {
  return Object.values(lists).map(list => list.mode === 'ready'
    ? list.items.map(item => 'title' in item ? item.title : item.name) : [list.mode])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })

  return { promise, resolve }
}

afterEach(() => {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })
})

describe('acknowledged Workflow domain writes reconcile mounted lists', () => {
  it.each(writes)('%s refreshes mounted projections without changing filters', async (_name, write) => {
    const bridge = installBridge()
    const { result } = renderHook(useMountedLists)
    await waitFor(() => expect(titles(result.current)).toEqual(Array(4).fill(['Original'])))
    await act(async () => { await write() })
    await waitFor(() => expect(titles(result.current)).toEqual(Array(4).fill(['Updated'])))
    expect(bridge.listProjects).toHaveBeenLastCalledWith({ limit: 25, status: 'active' })
    expect(bridge.listWorkflows).toHaveBeenLastCalledWith({ limit: 25, projectId: project.id, status: 'active' })
    expect(bridge.listDeliverables).toHaveBeenLastCalledWith({ kind: 'report', limit: 50, status: 'ready' })
    expect(bridge.listActivity).toHaveBeenLastCalledWith({ kinds: 'review', limit: 50 })
  })

  it.each(writes)('%s rejection leaves mounted reads intact', async (_name, write) => {
    const bridge = installBridge(false)
    const { result } = renderHook(useMountedLists)
    await waitFor(() => expect(titles(result.current)).toEqual(Array(4).fill(['Original'])))
    await act(async () => { await write() })
    expect(titles(result.current)).toEqual(Array(4).fill(['Original']))

    for (const read of [bridge.listProjects, bridge.listWorkflows, bridge.listDeliverables, bridge.listActivity]) {
      expect(read).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores an older Project response that settles after an acknowledged edit', async () => {
    const bridge = installBridge()
    const older = deferred<Awaited<ReturnType<typeof bridge.listProjects>>>()
    bridge.listProjects.mockImplementationOnce(() => older.promise)
    const { result } = renderHook(() => useWorkflowProjects())
    await waitFor(() => expect(bridge.listProjects).toHaveBeenCalledTimes(1))
    await act(async () => { await updateWorkflowProject({ name: 'Updated', objective: 'Objective', projectId: project.id }) })
    await waitFor(() => expect(result.current).toMatchObject({ items: [{ name: 'Updated' }], mode: 'ready' }))
    await act(async () => { older.resolve({ items: [project], nextCursor: null, ok: true, total: 1 }) })
    expect(result.current).toMatchObject({ items: [{ name: 'Updated' }], mode: 'ready' })
  })

  it.each(['deliverables', 'activity'] as const)('discards an old %s cursor page after a review refresh', async kind => {
    const bridge = installBridge()
    const oldPage = deferred<{ items: []; nextCursor: null; ok: boolean }>()

    if (kind === 'deliverables') {
      bridge.listDeliverables.mockResolvedValueOnce({ items: [deliverable], nextCursor: 'old-cursor', ok: true })
        .mockImplementationOnce(() => oldPage.promise)
    } else {
      bridge.listActivity.mockResolvedValueOnce({ items: [activity], nextCursor: 'old-cursor', ok: true })
        .mockImplementationOnce(() => oldPage.promise)
    }

    const { result } = renderHook(() => {
      const deliverables = useWorkflowDeliverables({ status: 'ready' })
      const activity = useWorkflowActivity('review')

      return kind === 'deliverables' ? deliverables : activity
    })

    await waitFor(() => expect(result.current.state).toMatchObject({ mode: 'ready', nextCursor: 'old-cursor' }))
    let pending!: Promise<void>
    act(() => { pending = result.current.loadMore() })
    await act(async () => { await reviewWorkflowDeliverable(deliverable.id, 'approved') })
    await waitFor(() => expect(result.current.state).toMatchObject({ items: [{ title: 'Updated' }], mode: 'ready', nextCursor: null }))
    // A rejected old page must not mark the new read failed or restore its cursor.
    await act(async () => { oldPage.resolve({ items: [], nextCursor: null, ok: false }); await pending })
    expect(result.current.state).toMatchObject({ items: [{ title: 'Updated' }], mode: 'ready', moreFailed: false, nextCursor: null })
  })
})
