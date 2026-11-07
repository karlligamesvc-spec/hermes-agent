import { afterEach, describe, expect, it } from 'vitest'

import {
  MULTI_BOT_FEATURE_NAME,
  namedProfileRpcOwner,
  setSingleEngineFlagForTest,
  SINGLE_ENGINE_FEATURE,
  SINGLE_THREAD_FEATURE_NAME,
  singleEngineSwitchFrom
} from './single-engine'
import { SINGLE_THREAD_FEATURE } from './single-thread'
import { MULTI_BOT_FEATURE } from './single-thread-bots'

// hc-1166: the renderer's copy of main's rule (electron/apex-single-engine.ts).

const payload = (features: Record<string, unknown>) => ({ desktop_features: features })
const allOn = { multi_bot: true, multi_bot_single_engine: true, single_thread: true }

afterEach(() => setSingleEngineFlagForTest(false))

describe('singleEngineSwitchFrom', () => {
  it('names the same features as the stores and main', () => {
    expect(SINGLE_THREAD_FEATURE_NAME).toBe(SINGLE_THREAD_FEATURE)
    expect(MULTI_BOT_FEATURE_NAME).toBe(MULTI_BOT_FEATURE)
    expect(SINGLE_ENGINE_FEATURE).toBe('multi_bot_single_engine')
  })

  it.each([
    ['every switch on in the platform config', { installSwitches: {}, payload: payload(allOn) }, true],
    ['nothing cached', null, false],
    [
      'the engine switch off',
      { installSwitches: {}, payload: payload({ ...allOn, multi_bot_single_engine: false }) },
      false
    ],
    ['several assistants off', { installSwitches: {}, payload: payload({ ...allOn, multi_bot: false }) }, false],
    ['single-thread off', { installSwitches: {}, payload: payload({ ...allOn, single_thread: false }) }, false],
    [
      'only a literal true counts',
      { installSwitches: {}, payload: payload({ ...allOn, multi_bot_single_engine: 'yes' }) },
      false
    ],
    [
      'this install switches it on',
      {
        installSwitches: { multi_bot_single_engine: true },
        payload: payload({ multi_bot: true, single_thread: true })
      },
      true
    ],
    [
      'this install switches it off',
      { installSwitches: { multi_bot_single_engine: false }, payload: payload(allOn) },
      false
    ],
    [
      'the install switch alone, with several assistants off',
      { installSwitches: { multi_bot_single_engine: true }, payload: payload({ single_thread: true }) },
      false
    ]
  ])('%s', (_case, state, on) => {
    expect(singleEngineSwitchFrom(state as never)).toBe(on)
  })
})

describe('namedProfileRpcOwner', () => {
  it.each([
    ['switch off', false, undefined, { profile: 'default' }, undefined],
    ['a call that names a session', true, 'rt-1', { profile: 'default' }, undefined],
    ['a call that names no profile', true, undefined, { title: 'APEX 主线' }, undefined],
    ['an empty profile', true, undefined, { profile: '  ' }, undefined],
    ['a call that names a profile', true, undefined, { profile: ' apex-bot-2 ' }, 'apex-bot-2'],
    ['no params', true, undefined, undefined, undefined]
  ])('%s', (_case, on, sessionId, params, owner) => {
    setSingleEngineFlagForTest(on as boolean)

    expect(namedProfileRpcOwner(sessionId as string | undefined, params as Record<string, unknown> | undefined)).toBe(
      owner
    )
  })
})
