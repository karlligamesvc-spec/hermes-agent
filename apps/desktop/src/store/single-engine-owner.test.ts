import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'

import { $mainThreadsByProfile, type MainThreadState } from './main-thread'
import { $activeGatewayProfile } from './profile'
import { clearAllSessionStates, publishSessionState } from './session-states'
import { setSingleEngineFlagForTest } from './single-engine'
import { engineEventProfile, sessionOwnerProfile } from './single-engine-owner'
import { type HandoffRecord, resetHandoffsForTest } from './single-thread-handoff'

// hc-1166: one engine tags every event and request with APEX's profile; the session says whose it is.

const writerThread = {
  ids: ['stored-writer'],
  profile: 'writer',
  rootId: 'stored-writer',
  status: 'found',
  tipId: 'stored-writer'
} as unknown as MainThreadState

beforeEach(() => {
  $mainThreadsByProfile.set({ writer: writerThread })
  publishSessionState('runtime-writer', {
    busy: true,
    needsInput: false,
    storedSessionId: 'stored-writer'
  } as ClientSessionState)
  resetHandoffsForTest([
    { id: 'relay-1', to: 'scribe', turn: { runtimeSessionId: 'runtime-relay' } } as unknown as HandoffRecord
  ])
  $activeGatewayProfile.set('writer')
})

afterEach(() => {
  setSingleEngineFlagForTest(false)
  $mainThreadsByProfile.set({})
  clearAllSessionStates()
  resetHandoffsForTest()
  $activeGatewayProfile.set('default')
})

describe('whose an engine event is', () => {
  it.each([
    ['an assistant’s thread', 'runtime-writer', undefined, 'writer'],
    ['a relay turn', 'runtime-relay', undefined, 'scribe'],
    ['a session this window does not know', 'runtime-unknown', undefined, 'default'],
    ['the session lists moved', undefined, 'sessions.changed', 'writer'],
    ['an IM pairing', undefined, 'pairing.changed', 'writer'],
    ['the engine came back', undefined, 'setup.ready', 'writer'],
    ['APEX’s skin', undefined, 'skin.changed', 'default'],
    ['APEX’s cron jobs', undefined, 'cron.changed', 'default'],
    ['APEX’s platforms', undefined, 'platforms.changed', 'default']
  ])('one engine: %s', (_case, sessionId, type, owner) => {
    setSingleEngineFlagForTest(true)

    expect(engineEventProfile('default', sessionId, type)).toBe(owner)
  })

  it.each([
    ['runtime-writer', undefined],
    [undefined, 'sessions.changed']
  ])('an engine per assistant keeps the tag (%s, %s)', (sessionId, type) => {
    expect(engineEventProfile('default', sessionId, type)).toBe('default')
    expect(engineEventProfile('writer', sessionId, type)).toBe('writer')
  })

  it('knows a session’s assistant whatever the switch says', () => {
    expect(sessionOwnerProfile('runtime-writer')).toBe('writer')
    expect(sessionOwnerProfile('runtime-relay')).toBe('scribe')
    expect(sessionOwnerProfile(undefined)).toBeNull()
  })
})
