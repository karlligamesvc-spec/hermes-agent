import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'
import { setDocumentHidden } from '@/test/window-state'

import { WORKFLOW_DOMAIN_POLL_INTERVAL_MS, workflowDomainChanged } from '../api/read-revision'

import { useWorkflowActivity, useWorkflowDeliverable, useWorkflowDeliverables } from './use-workflow-deliverables'
import { useWorkflowDefinitions, useWorkflowProject, useWorkflowProjectCompletion, useWorkflowProjects } from './use-workflow-domain-lists'
import { useWorkflowDomainRead } from './use-workflow-domain-read'
import { useWorkflowRun } from './use-workflow-run'

class WindowChannel extends EventTarget {
  static all = new Set<WindowChannel>()
  constructor(public name: string) {super(); WindowChannel.all.add(this)}
  postMessage(value: unknown) {
    for (const channel of WindowChannel.all) {
      if (channel !== this && channel.name === this.name) {channel.dispatchEvent(new MessageEvent('message', { data: value }))}
    }
  }
}

let focused = true

function account(accountId: string) {
  $authState.set({ ...$authState.get(), accountId, enabled: true, status: 'signed-in' })
}

function deferred<T>() {
  let resolve!: (value: T) => void

  return { promise: new Promise<T>(done => {resolve = done}), resolve: (value: T) => resolve(value) }
}

async function flush() {await act(async () => {await Promise.resolve(); await Promise.resolve(); await Promise.resolve()})}

function server() {
  let title = 'Original'
  const project = () => ({ createdAt: '', id: 'project', name: title, objective: title, status: 'active', updatedAt: '' })
  const item = () => ({ id: 'deliverable', title })

  const bridge = {
    access: vi.fn(async () => ({ available: true })),
    getDeliverable: vi.fn(async () => ({ ok: true, detail: { item: item() } })),
    getProject: vi.fn(async () => ({ ok: true, item: project() })),
    getProjectCompletion: vi.fn(async () => ({ ok: true, completion: { projectId: 'project', workflowTotal: title === 'Original' ? 1 : 2 } })),
    getRun: vi.fn(async () => ({ ok: true, overview: { run: { id: 'run', status: 'succeeded', triggerRef: title }, deliverables: [], events: [], steps: [] } })),
    listActivity: vi.fn(async () => ({ items: [{ id: 'activity', title }], nextCursor: null as null | string, ok: true })),
    listDeliverables: vi.fn(async () => ({ items: [item()], nextCursor: null as null | string, ok: true })),
    listProjects: vi.fn(async () => ({ items: [project()], nextCursor: null, ok: true, total: 1 })),
    listWorkflows: vi.fn(async () => ({ items: [{ id: 'workflow', name: title }], ok: true }))
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { workflowDomain: bridge } })

  return { bridge, change: (next: string) => {title = next} }
}

function useEveryMutableRead() {
  return {
    activity: useWorkflowActivity().state,
    deliverables: useWorkflowDeliverables().state,
    detail: useWorkflowDeliverable('deliverable'),
    project: useWorkflowProject('project'),
    completion: useWorkflowProjectCompletion('project'),
    projects: useWorkflowProjects(),
    workflows: useWorkflowDefinitions(),
    run: useWorkflowRun('run')
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('BroadcastChannel', WindowChannel)
  focused = true
  setDocumentHidden(false)
  vi.spyOn(globalThis.document, 'hasFocus').mockImplementation(() => focused)
  account('A')
})
afterEach(async () => {
  cleanup()
  await act(async () => vi.advanceTimersByTimeAsync(1001))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setDocumentHidden(false)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })
})

describe('mutable Workflow HTTP projections reconcile external changes', () => {
  it('coalesces slow periodic reads, catches rejected reads and reconciles bridge availability', async () => {
    const pending = deferred<{ mode: 'ready'; value: string }>()
    const read = vi.fn(() => pending.promise)
    const { result, rerender } = renderHook(({ available }) => useWorkflowDomainRead('slow', read, available), { initialProps: { available: true } })
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_DOMAIN_POLL_INTERVAL_MS * 2))
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ mode: 'ready', value: 'Confirmed' }))
    expect(result.current).toMatchObject({ mode: 'ready', refreshing: false, value: 'Confirmed' })
    read.mockRejectedValueOnce(new Error('Disconnected'))
    act(() => result.current.retry())
    await flush()
    expect(result.current).toMatchObject({ mode: 'ready', refreshFailed: true, value: 'Confirmed' })
    rerender({ available: false })
    expect(result.current).toMatchObject({ mode: 'unavailable', refreshFailed: false })
    read.mockResolvedValueOnce({ mode: 'ready', value: 'Reconnected' })
    rerender({ available: true })
    await flush()
    expect(result.current).toMatchObject({ mode: 'ready', refreshFailed: false, value: 'Reconnected' })
  })

  it('reads all eight projections for another window, server polling and focus return; failures retain facts and retry', async () => {
    const { bridge, change } = server()
    const { result } = renderHook(useEveryMutableRead)
    await flush()
    expect(result.current.project).toMatchObject({ item: { name: 'Original' }, mode: 'ready' })
    const peer = new WindowChannel('apex:workflow-domain')
    change('Other window')
    await act(async () => peer.postMessage(1))
    await flush()
    expect(result.current.detail).toMatchObject({ detail: { item: { title: 'Other window' } }, mode: 'ready' })
    expect(result.current.completion).toMatchObject({ completion: { workflowTotal: 2 } })
    expect(result.current.projects).toMatchObject({ items: [{ name: 'Other window' }] })
    expect(result.current.workflows).toMatchObject({ items: [{ name: 'Other window' }] })
    expect(result.current.activity).toMatchObject({ items: [{ title: 'Other window' }] })
    expect(result.current.deliverables).toMatchObject({ items: [{ title: 'Other window' }] })
    expect(result.current.run.overview).toMatchObject({ run: { triggerRef: 'Other window' } })

    change('Background writer')
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_DOMAIN_POLL_INTERVAL_MS))
    expect(result.current.project).toMatchObject({ item: { name: 'Background writer' } })
    focused = false
    setDocumentHidden(true)
    act(() => {window.dispatchEvent(new Event('blur')); globalThis.document.dispatchEvent(new Event('visibilitychange'))})
    const reads = bridge.getProject.mock.calls.length
    change('While away')
    peer.postMessage(1)
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_DOMAIN_POLL_INTERVAL_MS * 2))
    expect(bridge.getProject).toHaveBeenCalledTimes(reads)
    focused = true
    setDocumentHidden(false)
    act(() => {window.dispatchEvent(new Event('focus')); globalThis.document.dispatchEvent(new Event('visibilitychange'))})
    await flush()
    expect(bridge.getProject).toHaveBeenCalledTimes(reads + 1)
    expect(result.current.project).toMatchObject({ item: { name: 'While away' } })

    bridge.getProject.mockResolvedValueOnce({ ok: false, item: undefined! })
    act(workflowDomainChanged)
    await flush()
    expect(result.current.project).toMatchObject({ item: { name: 'While away' }, mode: 'ready', refreshFailed: true })
    change('Recovered')
    act(() => result.current.project.retry())
    await flush()
    expect(result.current.project).toMatchObject({ item: { name: 'Recovered' }, refreshFailed: false })
  })

  it.each(['projects', 'project', 'deliverables', 'run'] as const)('rejects a late %s response after account switches without relying on an unmount', async kind => {
    const { bridge, change } = server()
    const method = { projects: 'listProjects', project: 'getProject', deliverables: 'listDeliverables', run: 'getRun' }[kind] as keyof typeof bridge
    const pending = deferred<unknown>()
    bridge[method].mockImplementationOnce(() => pending.promise as never)
    const { result } = renderHook(useEveryMutableRead)
    await flush()
    change('Account B')
    act(() => account('B'))
    await flush()

    const old = { items: [{ id: 'old', name: 'Account A', title: 'Account A' }], item: { id: 'project', name: 'Account A' }, nextCursor: null, ok: true,
      overview: { run: { id: 'run', status: 'succeeded', triggerRef: 'Account A' }, deliverables: [], events: [], steps: [] }, total: 1 }

    await act(async () => pending.resolve(old))
    const state = result.current[kind]

    if (kind === 'run') {expect(state).toMatchObject({ overview: { run: { triggerRef: 'Account B' } } })}
    else if (kind === 'project') {expect(state).toMatchObject({ item: { name: 'Account B' } })}
    else {expect(state).toMatchObject({ items: [{ [kind === 'projects' ? 'name' : 'title']: 'Account B' }] })}
  })

  it.each(['signed-out', 'expired', 'disabled'] as const)('rejects late data after %s with the same cached UUID and ignores account cosmetic changes', async status => {
    const { bridge, change } = server()
    const old = deferred<Awaited<ReturnType<typeof bridge.getProject>>>()
    bridge.getProject.mockImplementationOnce(() => old.promise)
    const { result } = renderHook(() => useWorkflowProject('project'))
    await flush()
    const previous = $authState.get()
    act(() => $authState.set({ ...previous, account: { ...previous.account, name: 'New display name' } }))
    expect(bridge.getProject).toHaveBeenCalledTimes(1)
    change('Reconciled status')
    act(() => $authState.set({ ...$authState.get(), status }))
    await flush()
    expect(result.current).toMatchObject({ mode: 'ready', item: { name: 'Reconciled status' } })
    await act(async () => old.resolve({ ok: true, item: { createdAt: '', id: 'project', name: 'Old status', objective: '', status: 'active', updatedAt: '' } }))
    expect(result.current).toMatchObject({ mode: 'ready', item: { name: 'Reconciled status' } })
  })

  it('re-reads the loaded cursor chain and removes deleted rows while rejecting stale pages', async () => {
    const { bridge } = server()
    bridge.listDeliverables.mockResolvedValueOnce({ ok: true, items: [{ id: 'first', title: 'First' }], nextCursor: 'second' })
      .mockResolvedValueOnce({ ok: true, items: [{ id: 'deleted', title: 'Deleted' }], nextCursor: 'third' })
    const { result } = renderHook(() => useWorkflowDeliverables())
    await flush()
    await act(async () => result.current.loadMore())
    expect(result.current.state).toMatchObject({ items: [{ id: 'first' }, { id: 'deleted' }], nextCursor: 'third' })
    const pending = deferred<{ ok: boolean; items: []; nextCursor: null }>()
    bridge.listDeliverables.mockImplementationOnce(() => pending.promise)
    let more!: Promise<void>
    act(() => {more = result.current.loadMore()})
    bridge.listDeliverables.mockResolvedValueOnce({ ok: true, items: [{ id: 'first', title: 'Updated' }], nextCursor: 'fresh-second' })
      .mockResolvedValueOnce({ ok: true, items: [{ id: 'last', title: 'Last' }], nextCursor: null })
    act(workflowDomainChanged)
    await flush()
    expect(result.current.state).toMatchObject({ items: [{ id: 'first', title: 'Updated' }, { id: 'last' }], nextCursor: null })
    await act(async () => {pending.resolve({ ok: false, items: [], nextCursor: null }); await more})
    expect(result.current.state).toMatchObject({ moreFailed: false, nextCursor: null })
    expect(bridge.listDeliverables).toHaveBeenLastCalledWith({ cursor: 'fresh-second', kind: undefined, limit: 50, status: undefined })
  })
})
