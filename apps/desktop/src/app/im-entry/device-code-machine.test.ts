import { describe, expect, it } from 'vitest'

import { IM_ENTRY_CHANNELS, imEntryChannel, isImEntryChannelAvailable } from '@/lib/im-entry-catalog'

import {
  deviceCodeReduce,
  type DeviceCodeState,
  initialDeviceCodeState,
  isPolling,
  isTerminal,
  MAX_CONSECUTIVE_POLL_FAILURES
} from './device-code-machine'

// A convenience: run a sequence of events through the reducer from a start state.
function run(start: DeviceCodeState, ...events: Parameters<typeof deviceCodeReduce>[1][]): DeviceCodeState {
  return events.reduce((state, event) => deviceCodeReduce(state, event), start)
}

const ISSUED = {
  type: 'ISSUED' as const,
  deviceCode: 'dc_1',
  scanUrl: 'https://applink.feishu.cn/x',
  qrUrl: 'https://cdn/x.png',
  intervalMs: 3000,
  expiresAt: 1_000_000
}

describe('deviceCodeReduce — happy path', () => {
  it('START → ISSUED → POLL_RESULT(authorized)', () => {
    const issuing = deviceCodeReduce(initialDeviceCodeState(), { type: 'START' })
    expect(issuing.phase).toBe('issuing')

    const awaiting = deviceCodeReduce(issuing, ISSUED)
    expect(awaiting.phase).toBe('awaiting_scan')
    expect(awaiting.scanUrl).toBe('https://applink.feishu.cn/x')
    expect(awaiting.deviceCode).toBe('dc_1')
    expect(awaiting.expiresAt).toBe(1_000_000)
    expect(isPolling(awaiting)).toBe(true)
    expect(isTerminal(awaiting)).toBe(false)

    const authorized = deviceCodeReduce(awaiting, { type: 'POLL_RESULT', status: 'authorized' })
    expect(authorized.phase).toBe('authorized')
    expect(isPolling(authorized)).toBe(false)
    expect(isTerminal(authorized)).toBe(true)
  })

  it('reflects a scan-before-confirm as a sub-status without leaving awaiting_scan', () => {
    const awaiting = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)
    const scanned = deviceCodeReduce(awaiting, { type: 'POLL_RESULT', status: 'scanned' })
    expect(scanned.phase).toBe('awaiting_scan')
    expect(scanned.scanned).toBe(true)
    expect(isPolling(scanned)).toBe(true)
  })

  it('defaults a non-positive interval to 3000ms', () => {
    const awaiting = deviceCodeReduce(deviceCodeReduce(initialDeviceCodeState(), { type: 'START' }), {
      ...ISSUED,
      intervalMs: 0
    })

    expect(awaiting.intervalMs).toBe(3000)
  })
})

describe('deviceCodeReduce — stop conditions', () => {
  it('maps denied / expired / EXPIRE to the matching error reason', () => {
    const awaiting = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)
    expect(deviceCodeReduce(awaiting, { type: 'POLL_RESULT', status: 'denied' }).errorReason).toBe('denied')
    expect(deviceCodeReduce(awaiting, { type: 'POLL_RESULT', status: 'expired' }).errorReason).toBe('expired')
    expect(deviceCodeReduce(awaiting, { type: 'EXPIRE' }).errorReason).toBe('expired')
  })

  it('surfaces sign_in / service_unavailable from issue immediately', () => {
    const issuing = deviceCodeReduce(initialDeviceCodeState(), { type: 'START' })
    expect(deviceCodeReduce(issuing, { type: 'ISSUE_FAILED', reason: 'sign_in' }).errorReason).toBe('sign_in')
    expect(deviceCodeReduce(issuing, { type: 'ISSUE_FAILED', reason: 'service_unavailable' }).errorReason).toBe(
      'service_unavailable'
    )
  })

  it('treats sign_in / service_unavailable poll failures as immediately terminal', () => {
    const awaiting = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)
    expect(deviceCodeReduce(awaiting, { type: 'POLL_FAILED', reason: 'sign_in' }).errorReason).toBe('sign_in')
    expect(deviceCodeReduce(awaiting, { type: 'POLL_FAILED', reason: 'service_unavailable' }).phase).toBe('error')
  })

  it('tolerates transient poll failures up to the cap, then gives up', () => {
    let state = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)

    for (let i = 1; i < MAX_CONSECUTIVE_POLL_FAILURES; i += 1) {
      state = deviceCodeReduce(state, { type: 'POLL_FAILED', reason: 'request_failed' })
      expect(state.phase).toBe('awaiting_scan')
      expect(state.consecutiveFailures).toBe(i)
    }

    // The cap-th consecutive failure gives up.
    state = deviceCodeReduce(state, { type: 'POLL_FAILED', reason: 'request_failed' })
    expect(state.phase).toBe('error')
    expect(state.errorReason).toBe('request_failed')
  })

  it('resets the failure counter on any good poll result', () => {
    let state = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)
    state = deviceCodeReduce(state, { type: 'POLL_FAILED', reason: 'request_failed' })
    state = deviceCodeReduce(state, { type: 'POLL_FAILED', reason: 'request_failed' })
    expect(state.consecutiveFailures).toBe(2)
    state = deviceCodeReduce(state, { type: 'POLL_RESULT', status: 'pending' })
    expect(state.consecutiveFailures).toBe(0)
  })
})

describe('deviceCodeReduce — guards & lifecycle', () => {
  it('ignores events that do not belong to the current phase', () => {
    const idle = initialDeviceCodeState()
    // POLL_RESULT while idle is a no-op.
    expect(deviceCodeReduce(idle, { type: 'POLL_RESULT', status: 'authorized' })).toEqual(idle)
    // ISSUED while idle (not issuing) is a no-op.
    expect(deviceCodeReduce(idle, ISSUED)).toEqual(idle)
    // A double START while issuing is a no-op.
    const issuing = deviceCodeReduce(idle, { type: 'START' })
    expect(deviceCodeReduce(issuing, { type: 'START' })).toEqual(issuing)
  })

  it('can be restarted from an error state but not mid-flight', () => {
    const errored = run(
      initialDeviceCodeState(),
      { type: 'START' },
      { type: 'ISSUE_FAILED', reason: 'request_failed' }
    )

    expect(errored.phase).toBe('error')
    expect(deviceCodeReduce(errored, { type: 'START' }).phase).toBe('issuing')
  })

  it('FAIL raises a terminal error mid-flight (keychain) but is ignored when resting', () => {
    const awaiting = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)
    expect(deviceCodeReduce(awaiting, { type: 'FAIL', reason: 'keychain' }).errorReason).toBe('keychain')
    // Ignored once already authorized/idle/error (no clobber of a resolved flow).
    const authorized = deviceCodeReduce(awaiting, { type: 'POLL_RESULT', status: 'authorized' })
    expect(deviceCodeReduce(authorized, { type: 'FAIL', reason: 'keychain' })).toEqual(authorized)
    expect(deviceCodeReduce(initialDeviceCodeState(), { type: 'FAIL', reason: 'keychain' }).phase).toBe('idle')
  })

  it('CANCEL / RESET always return to idle', () => {
    const awaiting = run(initialDeviceCodeState(), { type: 'START' }, ISSUED)
    expect(deviceCodeReduce(awaiting, { type: 'CANCEL' })).toEqual(initialDeviceCodeState())
    expect(deviceCodeReduce(awaiting, { type: 'RESET' })).toEqual(initialDeviceCodeState())
  })
})

describe('IM 入口 channel catalog', () => {
  it('ships feishu as the only available channel (first in order)', () => {
    expect(IM_ENTRY_CHANNELS[0].id).toBe('feishu')
    expect(isImEntryChannelAvailable('feishu')).toBe(true)
    const available = IM_ENTRY_CHANNELS.filter(c => c.available).map(c => c.id)
    expect(available).toEqual(['feishu'])
  })

  it('queues dingtalk as the next (coming-soon) candidate', () => {
    expect(IM_ENTRY_CHANNELS[1].id).toBe('dingtalk')
    expect(isImEntryChannelAvailable('dingtalk')).toBe(false)
  })

  it('feishu uses the device-code template; every id is unique', () => {
    expect(imEntryChannel('feishu')?.bindingKind).toBe('device-code')
    const ids = IM_ENTRY_CHANNELS.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns undefined / false for unknown ids', () => {
    expect(imEntryChannel('nope')).toBeUndefined()
    expect(isImEntryChannelAvailable('nope')).toBe(false)
  })
})
