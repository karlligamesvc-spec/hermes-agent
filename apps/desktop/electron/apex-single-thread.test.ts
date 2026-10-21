/**
 * hc-1015: the single-thread switch as main settles it at launch, and the
 * config heal that pins the managed model to the default tier alias while it
 * is on (decision 5: the user sees no tier; the shell sends the default).
 *
 * Run with: npx vitest run electron/apex-single-thread.test.ts --project electron
 */

import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { clientConfigForRenderer } from './apex-desktop-features'
import { DEFAULT_RELAY_BASE_URL } from './apex-managed'
import {
  applyDesktopFeatureSwitches,
  healManagedModelTier,
  migrateManagedModelToTierYaml,
  TIER_DEFAULT_MANAGED_MODEL
} from './apex-model-tiers'
import {
  applySingleThreadSwitch,
  isSingleThreadEnabled,
  SINGLE_THREAD_ENV,
  singleThreadFromClientConfig
} from './apex-single-thread'

const RELAY = DEFAULT_RELAY_BASE_URL
const ON = { desktop_features: { single_thread: true } }

describe('the platform switch', () => {
  test.each([
    [ON, true],
    [{ desktop_features: { single_thread: 'true' } }, false],
    [{ desktop_features: { single_thread: 1 } }, false],
    [{ desktop_features: { model_tiers: true } }, false],
    [{ desktop_features: [] }, false],
    [[], false],
    [null, false]
  ])('reads %j as %s', (payload, on) => {
    assert.equal(singleThreadFromClientConfig(payload), on)
  })

  test('is settled into the env, and an env value the user set wins', () => {
    const lines: string[] = []
    const env: Record<string, string | undefined> = {}

    assert.equal(
      applySingleThreadSwitch(env, ON, line => lines.push(line)),
      true
    )
    assert.equal(env[SINGLE_THREAD_ENV], '1')
    assert.equal(isSingleThreadEnabled(env), true)
    assert.deepEqual(lines, ['[client-config] APEXNODES_SINGLE_THREAD=1 from platform desktop_features'])

    const optedOut = { [SINGLE_THREAD_ENV]: '0' }

    assert.equal(applySingleThreadSwitch(optedOut, ON), false)
    assert.equal(isSingleThreadEnabled(optedOut), false)

    const off: Record<string, string | undefined> = {}

    assert.equal(applySingleThreadSwitch(off, { desktop_features: {} }), false)
    assert.equal(off[SINGLE_THREAD_ENV], undefined)
  })

  test('reads back as hc-1014’s install switch, so the chat and the engine agree for the launch', () => {
    const env: Record<string, string | undefined> = {}
    const state = { appliedVersion: 3, payload: ON, version: 3 }

    applySingleThreadSwitch(env, ON)

    assert.deepEqual(clientConfigForRenderer(state, env).installSwitches, { single_thread: true })
    assert.deepEqual(clientConfigForRenderer(state, { [SINGLE_THREAD_ENV]: '0' }).installSwitches, {
      single_thread: false
    })
  })

  test('settles with the tier switches in one launch-time call', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(
      applyDesktopFeatureSwitches(env, { desktop_features: { model_tiers: true, single_thread: true } }),
      ['APEXNODES_MODEL_TIERS', SINGLE_THREAD_ENV]
    )
    assert.equal(env.APEXNODES_MODEL_TIERS, '1')
    assert.equal(env[SINGLE_THREAD_ENV], '1')
  })
})

describe('the default tier alias, pinned in single-thread mode', () => {
  const block = (provider: string, model: string, baseUrl = RELAY) =>
    `model:\n  default: ${model}\n  provider: ${provider}\n  base_url: ${baseUrl}\n  api_key: sk-test\n`

  const managed = { baseUrl: RELAY, key: 'sk-test' }
  const singleThread = { [SINGLE_THREAD_ENV]: '1' }

  test.each([
    ['a Pro pick', block('custom:apex-nodes.com', 'apex-pro'), 'apex-pro'],
    ['a Max pick', block('custom', 'apex-max'), 'apex-max'],
    ['the -APEX seed', block('custom', 'deepseek-flash-APEX'), 'deepseek-flash-APEX']
  ])('moves %s to the default', (_label, raw, from) => {
    const fixed: string[] = []
    const healed = healManagedModelTier(raw, managed, RELAY, singleThread, fixed)

    assert.match(healed, new RegExp(`^ {2}default: ${TIER_DEFAULT_MANAGED_MODEL}$`, 'm'))
    assert.deepEqual(fixed, [`model(single-thread:${from}→flash)`])
    assert.equal(healed.replace(/^ {2}default: .*$/m, ''), raw.replace(/^ {2}default: .*$/m, ''))
  })

  test.each([
    ['the default already', block('custom', TIER_DEFAULT_MANAGED_MODEL)],
    ['the user’s own provider', block('deepseek', 'deepseek-chat', 'https://api.deepseek.com/v1')],
    ['a custom endpoint elsewhere', block('custom', 'apex-pro', 'http://127.0.0.1:8080/v1')]
  ])('leaves %s alone', (_label, raw) => {
    const fixed: string[] = []

    assert.equal(healManagedModelTier(raw, managed, RELAY, singleThread, fixed), raw)
    assert.deepEqual(fixed, [])
  })

  test('needs a managed credential, and keeps a tier pick while only tiers are on', () => {
    const pro = block('custom:apex-nodes.com', 'apex-pro')
    const fixed: string[] = []

    assert.equal(healManagedModelTier(pro, { baseUrl: RELAY }, RELAY, singleThread, fixed), pro, 'no managed key')
    assert.equal(healManagedModelTier(pro, managed, RELAY, { APEXNODES_MODEL_TIERS: '1' }, fixed), pro, 'tiers only')
    assert.equal(healManagedModelTier(pro, managed, RELAY, {}, fixed), pro, 'both off')
    assert.deepEqual(fixed, [])
    assert.equal(migrateManagedModelToTierYaml(pro, RELAY).changed, false, 'the tier migration keeps its tiers')
  })
})
