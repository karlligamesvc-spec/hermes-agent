import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setDocumentHidden } from '@/test/window-state'

import type { WorkflowRunOverview } from '../api/types'

import { useWorkflowRun, WORKFLOW_RUN_POLL_INTERVAL_MS } from './use-workflow-run'

function overview(status: string): WorkflowRunOverview {
  return {
    deliverables: [],
    events: [],
    run: {
      attempt: 1,
      completedAt: status === 'succeeded' ? '2026-09-06T10:03:00Z' : null,
      createdAt: '2026-09-06T10:00:00Z',
      executorType: 'hermes',
      id: 'run-820',
      maxAttempts: 2,
      startedAt: '2026-09-06T10:00:01Z',
      status,
      triggerRef: 'Review a real workflow Run',
      updatedAt: '2026-09-06T10:02:00Z'
    }
  }
}

function installRunBridge(getRun: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      workflowDomain: {
        access: vi.fn(),
        cancelRun: vi.fn(),
        getRun,
        reviewDeliverable: vi.fn(),
        startGoal: vi.fn()
      }
    }
  })
}

async function flushInitialLoad() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useWorkflowRun polling and cache contract', () => {
  let focused = true

  beforeEach(() => {
    focused = true
    vi.useFakeTimers()
    setDocumentHidden(false)
    vi.spyOn(globalThis.document, 'hasFocus').mockImplementation(() => focused)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    setDocumentHidden(false)
  })

  it('polls an active Run every three seconds and stops after a terminal response', async () => {
    const getRun = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, overview: overview('running') })
      .mockResolvedValueOnce({ ok: true, overview: overview('succeeded') })

    installRunBridge(getRun)
    const { result } = renderHook(() => useWorkflowRun('run-820'))

    await flushInitialLoad()
    expect(getRun).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS))
    expect(getRun).toHaveBeenCalledTimes(2)
    expect(result.current.overview?.run.status).toBe('succeeded')

    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS * 3))
    expect(getRun).toHaveBeenCalledTimes(2)
  })

  it('pauses high-frequency polling while hidden and refreshes immediately on return', async () => {
    const getRun = vi.fn(async () => ({ ok: true, overview: overview('running') }))
    installRunBridge(getRun)
    renderHook(() => useWorkflowRun('run-820'))

    await flushInitialLoad()
    focused = false
    setDocumentHidden(true)
    globalThis.document.dispatchEvent(new Event('visibilitychange'))

    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS * 4))
    expect(getRun).toHaveBeenCalledTimes(1)

    focused = true
    setDocumentHidden(false)
    await act(async () => globalThis.document.dispatchEvent(new Event('visibilitychange')))
    expect(getRun).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS))
    expect(getRun).toHaveBeenCalledTimes(3)
  })

  it('keeps the last successful Run data when a later refresh fails', async () => {
    const cached = overview('running')
    const getRun = vi.fn().mockResolvedValueOnce({ ok: true, overview: cached }).mockResolvedValueOnce({ ok: false })
    installRunBridge(getRun)
    const { result } = renderHook(() => useWorkflowRun('run-820'))

    await flushInitialLoad()
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS))

    expect(result.current.failed).toBe(true)
    expect(result.current.overview).toBe(cached)
  })

  it('keeps waiting-for-review Runs live but never polls a terminal Run', async () => {
    const waitingGetRun = vi.fn(async () => ({ ok: true, overview: overview('waiting_review') }))
    installRunBridge(waitingGetRun)
    const waiting = renderHook(() => useWorkflowRun('run-waiting'))

    await flushInitialLoad()
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS))
    expect(waitingGetRun).toHaveBeenCalledTimes(2)
    waiting.unmount()

    const terminalGetRun = vi.fn(async () => ({ ok: true, overview: overview('failed') }))
    installRunBridge(terminalGetRun)
    renderHook(() => useWorkflowRun('run-failed'))

    await flushInitialLoad()
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS * 2))
    expect(terminalGetRun).toHaveBeenCalledTimes(1)
  })
})
