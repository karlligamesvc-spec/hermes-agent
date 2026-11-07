import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { $approvalModes, approvalModeForProfile } from '@/store/approval-mode'
import { $cronChangeTick, $pairingChangeTick, $platformsChangeTick, $sessionsChangeTick } from '@/store/live-sync'
import { $mainThreadsByProfile, type MainThreadState } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'
import { setSingleEngineFlagForTest } from '@/store/single-engine'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const ACTIVE_SID = 'session-active'
let stream: MessageStreamHarness

function mountStream() {
  stream = renderMessageStream(ACTIVE_SID)
}

describe('live session.info approval mode reconciliation', () => {
  beforeEach(() => {
    $approvalModes.set({})
    $activeGatewayProfile.set('work')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reconciles an active-session event under its source gateway profile', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { approval_mode: 'off' },
        profile: 'work',
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(approvalModeForProfile('work')).toBe('off')
    expect(approvalModeForProfile('default')).toBe('smart')
  })

  it('ignores stale session.info from a non-active session on the active gateway', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { approval_mode: 'off' },
        profile: 'work',
        session_id: 'session-stale',
        type: 'session.info'
      })
    )

    expect(approvalModeForProfile('work')).toBe('smart')
  })

  it('does not cache an event under a different active profile when its source profile is absent', () => {
    mountStream()
    $activeGatewayProfile.set('personal')

    act(() => stream.handleEvent({ payload: { approval_mode: 'off' }, session_id: ACTIVE_SID, type: 'session.info' }))

    expect(approvalModeForProfile('personal')).toBe('smart')
    expect(approvalModeForProfile('work')).toBe('smart')
  })
})

// hc-1166: one engine tags every event APEX's ('default'); whose it is comes from the session or the event type.
describe('one engine for every assistant, another assistant on screen', () => {
  function onScreenWriter() {
    $approvalModes.set({})
    $activeGatewayProfile.set('writer')
    $mainThreadsByProfile.set({
      writer: {
        ids: ['stored-writer'],
        profile: 'writer',
        rootId: 'stored-writer',
        status: 'found',
        tipId: 'stored-writer'
      }
    } as unknown as Record<string, MainThreadState>)
    mountStream()
    publishSessionState(ACTIVE_SID, {
      busy: false,
      needsInput: false,
      storedSessionId: 'stored-writer'
    } as ClientSessionState)
  }

  afterEach(() => {
    cleanup()
    setSingleEngineFlagForTest(false)
    $mainThreadsByProfile.set({})
    clearAllSessionStates()
    $activeGatewayProfile.set('default')
  })

  it.each([
    [true, 'off', 'smart'],
    [false, 'smart', 'smart']
  ])('switch %s: the on-screen session’s approval mode is the assistant’s, never APEX’s', (on, writer, apex) => {
    setSingleEngineFlagForTest(on)
    onScreenWriter()

    act(() =>
      stream.handleEvent({
        payload: { approval_mode: 'off' },
        profile: 'default',
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(approvalModeForProfile('writer')).toBe(writer)
    expect(approvalModeForProfile('default')).toBe(apex)
  })

  it('takes the session-list and pairing broadcasts, and leaves APEX’s cron and platform ones', () => {
    setSingleEngineFlagForTest(true)
    onScreenWriter()

    const before = [
      $sessionsChangeTick.get(),
      $pairingChangeTick.get(),
      $cronChangeTick.get(),
      $platformsChangeTick.get()
    ]

    for (const type of ['sessions.changed', 'pairing.changed', 'cron.changed', 'platforms.changed'] as const) {
      act(() => stream.handleEvent({ profile: 'default', type }))
    }

    expect([
      $sessionsChangeTick.get(),
      $pairingChangeTick.get(),
      $cronChangeTick.get(),
      $platformsChangeTick.get()
    ]).toEqual([before[0] + 1, before[1] + 1, before[2], before[3]])
  })

  it('an engine per assistant drops them all, as before', () => {
    onScreenWriter()
    const before = [$sessionsChangeTick.get(), $pairingChangeTick.get()]

    act(() => stream.handleEvent({ profile: 'default', type: 'sessions.changed' }))
    act(() => stream.handleEvent({ profile: 'default', type: 'pairing.changed' }))

    expect([$sessionsChangeTick.get(), $pairingChangeTick.get()]).toEqual(before)
  })
})
