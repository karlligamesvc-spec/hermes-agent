/**
 * hc-1166: the main-process switch for several assistants on one engine, and
 * what the profile route reads from it.
 *
 * Run with: npx vitest run electron/apex-single-engine.test.ts --project electron
 */

import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { DESKTOP_FEATURE_ENV } from './apex-desktop-features'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import {
  isSingleEngineActive,
  MULTI_BOT_ACTIVE_ENV,
  SINGLE_ENGINE_ACTIVE_ENV,
  withLocalSharedPrimary
} from './apex-profile-homes'
import { applySingleEngineSwitch, SINGLE_ENGINE_FEATURE, singleEngineOnForLaunch } from './apex-single-engine'

const ASSISTANTS_ON = { desktop_features: { multi_bot: true, single_thread: true } }
const ONE_ENGINE_ON = { desktop_features: { ...ASSISTANTS_ON.desktop_features, multi_bot_single_engine: true } }

describe('the switch for this launch', () => {
  test.each([
    ['on in the platform config', {}, ONE_ENGINE_ON, true],
    ['off in the platform config', {}, ASSISTANTS_ON, false],
    [
      'only a literal true counts',
      {},
      { desktop_features: { ...ASSISTANTS_ON.desktop_features, multi_bot_single_engine: 'true' } },
      false
    ],
    ['this install turns it on', { APEXNODES_MULTI_BOT_SINGLE_ENGINE: '1' }, ASSISTANTS_ON, true],
    ['this install turns it off', { APEXNODES_MULTI_BOT_SINGLE_ENGINE: '0' }, ONE_ENGINE_ON, false],
    [
      'several assistants off',
      { APEXNODES_MULTI_BOT: '0', APEXNODES_MULTI_BOT_SINGLE_ENGINE: '1' },
      ONE_ENGINE_ON,
      false
    ],
    [
      'single-thread off',
      { APEXNODES_SINGLE_THREAD: '0', APEXNODES_MULTI_BOT_SINGLE_ENGINE: '1' },
      ONE_ENGINE_ON,
      false
    ],
    ['nothing cached', { APEXNODES_MULTI_BOT_SINGLE_ENGINE: '1' }, null, false]
  ] as const)('%s → %s', (_label, install, payload, on) => {
    assert.equal(singleEngineOnForLaunch({ ...install }, payload), on)
  })

  test('the install switch is one of the documented desktop_features switches', () => {
    assert.equal(DESKTOP_FEATURE_ENV[SINGLE_ENGINE_FEATURE], 'APEXNODES_MULTI_BOT_SINGLE_ENGINE')
  })
})

describe('settling the engine signal', () => {
  test('on: set to 1 with one desktop.log line, and named among the launch switches', () => {
    const env: Record<string, string | undefined> = {}
    const lines: string[] = []

    const set = applyDesktopFeatureSwitches(env, ONE_ENGINE_ON, line => lines.push(line))

    assert.equal(env[SINGLE_ENGINE_ACTIVE_ENV], '1')
    assert.ok(set.includes(SINGLE_ENGINE_ACTIVE_ENV))
    assert.ok(
      lines.includes(`[client-config] ${SINGLE_ENGINE_ACTIVE_ENV}=1 (desktop_features.multi_bot_single_engine)`)
    )
  })

  test('off: a value left from an earlier settle is removed', () => {
    const env: Record<string, string | undefined> = { [SINGLE_ENGINE_ACTIVE_ENV]: '1' }

    assert.equal(applySingleEngineSwitch(env, ASSISTANTS_ON), false)
    assert.equal(env[SINGLE_ENGINE_ACTIVE_ENV], undefined)
  })
})

describe('what the profile route reads', () => {
  test.each([
    ['both signals', { [MULTI_BOT_ACTIVE_ENV]: '1', [SINGLE_ENGINE_ACTIVE_ENV]: '1' }, true],
    ['the engine signal alone', { [SINGLE_ENGINE_ACTIVE_ENV]: '1' }, false],
    ['several assistants alone', { [MULTI_BOT_ACTIVE_ENV]: '1' }, false],
    ['neither', {}, false]
  ] as const)('%s → %s', (_label, env, on) => {
    assert.equal(isSingleEngineActive({ ...env }), on)
    assert.deepEqual(withLocalSharedPrimary({ ...env }, { globalRemote: false, primaryProfile: 'default' }), {
      globalRemote: false,
      localSharedPrimary: on,
      primaryProfile: 'default'
    })
  })
})
