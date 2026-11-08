/**
 * hc-1183: a one-shot task that ends while the user is away raises a real OS notification.
 *
 * cron-outcome.test.tsx mocks dispatchNativeNotification, so it pins which kind is asked for but not whether the
 * notification survives shouldFire. Here the real store runs, down to the window.hermesDesktop.notify bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { setCronJobs } from './cron'
import { NATIVE_NOTIFICATION_KINDS, setNativeNotifyEnabled, setNativeNotifyKind } from './native-notifications'
import { __resetNativeNotifyBaselineForTests } from './notify-baseline'
import { setActiveSessionId } from './session'
import { __resetTaskNotifierState, startTaskNotifier } from './tasks'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const notify = vi.fn().mockResolvedValue(true)

function setWindowState({ focused, hidden }: { focused: boolean; hidden: boolean }) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
}

let counter = 0

// A fresh id per job keeps the store's one-second throttle (keyed by kind and tag) out of the way.
function freshId(): string {
  counter += 1

  return `hc1183-task-${counter}`
}

function task(id: string, lastStatus: null | string, running: boolean): CronJob & { last_status: null | string } {
  return {
    id,
    name: `今日财经 ${id}`,
    enabled: running,
    state: running ? 'scheduled' : 'completed',
    schedule: { kind: 'once', display: 'once in 1m' },
    next_run_at: null,
    last_run_at: running ? null : '2026-11-08T17:37:12Z',
    last_status: lastStatus,
    last_error: lastStatus === 'error' ? 'fixture failure' : null
  }
}

function runThenEnd(ids: string[], lastStatus: string) {
  setCronJobs(ids.map(id => task(id, null, true)))
  setCronJobs(ids.map(id => task(id, lastStatus, false)))
}

let stop: () => void = () => {}

beforeEach(() => {
  notify.mockClear()
  desktopWindow.hermesDesktop = { notify } as unknown as Window['hermesDesktop']
  setNativeNotifyEnabled(true)

  for (const kind of NATIVE_NOTIFICATION_KINDS) {
    setNativeNotifyKind(kind, true)
  }

  __resetNativeNotifyBaselineForTests()
  __resetTaskNotifierState()
  setCronJobs([])
  setActiveSessionId('the-main-thread')
  stop = startTaskNotifier()
})

afterEach(() => {
  stop()
  setCronJobs([])

  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
})

describe('task notifications reach the OS', () => {
  it.each([
    ['ok', 'backgroundDone'],
    ['error', 'turnError'],
    ['delivery_failed', 'turnError']
  ])('a task ending with %s while the window is hidden notifies once as %s', (status, kind) => {
    setWindowState({ focused: false, hidden: true })
    const id = freshId()
    runThenEnd([id], status)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind, tag: `task:${id}` }))
  })

  it('also notifies when the window is shown but another app has the focus', () => {
    setWindowState({ focused: false, hidden: false })
    runThenEnd([freshId()], 'ok')

    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while the user is looking at APEX', () => {
    setWindowState({ focused: true, hidden: false })
    runThenEnd([freshId()], 'ok')

    expect(notify).not.toHaveBeenCalled()
  })

  it('two tasks ending together are two notifications', () => {
    setWindowState({ focused: false, hidden: true })
    const ids = [freshId(), freshId()]
    runThenEnd(ids, 'ok')

    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls.map(([payload]) => payload.tag).sort()).toEqual(ids.map(id => `task:${id}`).sort())
  })

  it('carries no chat session, so a click does not jump into some conversation', () => {
    setWindowState({ focused: false, hidden: true })
    runThenEnd([freshId()], 'ok')

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined, focusSessionId: undefined }))
  })

  it('leaves a job that posts its result back into its chat to that notification (hc-1186)', () => {
    setWindowState({ focused: false, hidden: true })
    const id = freshId()
    const origin = { apex_desktop_origin: { session_id: 'chat-1' }, deliver: 'origin' }
    setCronJobs([{ ...task(id, null, true), ...origin }])
    setCronJobs([{ ...task(id, 'ok', false), ...origin }])

    expect(notify).not.toHaveBeenCalled()
  })

  it('still notifies for a save-only job made in a chat (nothing comes back there)', () => {
    setWindowState({ focused: false, hidden: true })
    const id = freshId()
    const origin = { apex_desktop_origin: { session_id: 'chat-1' }, deliver: 'local' }
    setCronJobs([{ ...task(id, null, true), ...origin }])
    setCronJobs([{ ...task(id, 'ok', false), ...origin }])

    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('respects the backgroundDone switch in Settings › 通知', () => {
    setWindowState({ focused: false, hidden: true })
    setNativeNotifyKind('backgroundDone', false)
    runThenEnd([freshId()], 'ok')

    expect(notify).not.toHaveBeenCalled()
  })
})
