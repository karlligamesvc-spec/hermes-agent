/**
 * hc-1186 through the real gateway-event dispatcher: a `cron.changed` broadcast carrying a scheduled result
 * raises the notification, and the cron list still refreshes (the handler never takes the event).
 */
import type { GatewayEvent } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $cronChangeTick } from '@/store/live-sync'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const notifyCronResult = vi.fn()

vi.mock('@/store/cron-result-notify', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyCronResult: (...args: unknown[]) => notifyCronResult(...args)
}))

const RESULT = {
  apex_cron_result: {
    session_id: '20261108_093309_be257d',
    job_id: 'job-1',
    job_name: '今日财经',
    status: 'ok',
    delivery_id: 'exec-1',
    profile: 'default'
  }
}

let stream: MessageStreamHarness

function emit(payload: GatewayEvent['payload']) {
  act(() => stream.handleEvent({ payload, session_id: '', type: 'cron.changed' } as GatewayEvent))
}

beforeEach(() => {
  notifyCronResult.mockReset()
  stream = renderMessageStream('session-1')
})

afterEach(() => {
  cleanup()
})

describe('cron.changed with a scheduled result', () => {
  it('notifies once and still refreshes the cron list', () => {
    const before = $cronChangeTick.get()

    emit(RESULT)

    expect(notifyCronResult).toHaveBeenCalledTimes(1)
    expect(notifyCronResult).toHaveBeenCalledWith(RESULT.apex_cron_result)
    expect($cronChangeTick.get()).toBe(before + 1)
  })

  it('a plain cron list change notifies nothing', () => {
    emit({})

    expect(notifyCronResult).not.toHaveBeenCalled()
  })
})
