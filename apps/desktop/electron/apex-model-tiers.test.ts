/**
 * hc-960: the Flash / Pro / Max switch, the tier alias as the managed
 * default, and the boot migration off pre-tier managed ids.
 *
 * Run with: npx vitest run electron/apex-model-tiers.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

import {
  buildManagedModelConfig,
  DEFAULT_MANAGED_MODEL,
  DEFAULT_RELAY_BASE_URL,
  MANAGED_MODEL_DISPLAY,
  resolveApexEndpoints
} from './apex-managed'
import {
  applyModelTierSwitches,
  healManagedModelTier,
  isModelTierAlias,
  isModelTierMaxEnabled,
  isModelTiersEnabled,
  migrateManagedModelToTierYaml,
  MODEL_TIER_ALIASES,
  modelTierStatus,
  modelTierSwitchesFromClientConfig,
  TIER_DEFAULT_MANAGED_MODEL
} from './apex-model-tiers'

const RELAY = DEFAULT_RELAY_BASE_URL

describe('the tier switch', () => {
  test('is off unless explicitly turned on', () => {
    assert.equal(isModelTiersEnabled({}), false)
    assert.equal(isModelTiersEnabled({ APEXNODES_MODEL_TIERS: '' }), false)
    assert.equal(isModelTiersEnabled({ APEXNODES_MODEL_TIERS: 'maybe' }), false)
    assert.equal(isModelTiersEnabled({ APEXNODES_MODEL_TIERS: '0' }), false)

    for (const on of ['1', 'true', 'YES', ' on ']) {
      assert.equal(isModelTiersEnabled({ APEXNODES_MODEL_TIERS: on }), true, on)
    }
  })

  test('Max needs its own switch on top of tiers', () => {
    assert.equal(isModelTierMaxEnabled({ APEXNODES_MODEL_TIER_MAX: '1' }), false)
    assert.equal(isModelTierMaxEnabled({ APEXNODES_MODEL_TIERS: '1' }), false)
    assert.equal(isModelTierMaxEnabled({ APEXNODES_MODEL_TIERS: '1', APEXNODES_MODEL_TIER_MAX: '1' }), true)
  })

  test('reads only literal true from the platform client config', () => {
    assert.deepEqual(modelTierSwitchesFromClientConfig(null), { modelTiers: false, modelTierMax: false })
    assert.deepEqual(modelTierSwitchesFromClientConfig({ config_yaml: {} }), { modelTiers: false, modelTierMax: false })
    assert.deepEqual(modelTierSwitchesFromClientConfig({ desktop_features: { model_tiers: 'true' } }), {
      modelTiers: false,
      modelTierMax: false
    })
    assert.deepEqual(
      modelTierSwitchesFromClientConfig({ desktop_features: { model_tiers: true, model_tier_max: true } }),
      { modelTiers: true, modelTierMax: true }
    )
  })

  test('the platform turns a switch on only where the env said nothing', () => {
    const env: Record<string, string | undefined> = {}
    const payload = { desktop_features: { model_tiers: true, model_tier_max: true } }

    assert.deepEqual(applyModelTierSwitches(env, payload), ['APEXNODES_MODEL_TIERS', 'APEXNODES_MODEL_TIER_MAX'])
    assert.equal(isModelTiersEnabled(env), true)
    assert.equal(isModelTierMaxEnabled(env), true)

    const optedOut: Record<string, string | undefined> = { APEXNODES_MODEL_TIERS: '0' }
    assert.deepEqual(applyModelTierSwitches(optedOut, payload), ['APEXNODES_MODEL_TIER_MAX'])
    assert.equal(isModelTiersEnabled(optedOut), false, 'an explicit 0 in the env beats the platform')
    assert.equal(isModelTierMaxEnabled(optedOut), false)

    const untouched: Record<string, string | undefined> = {}
    assert.deepEqual(applyModelTierSwitches(untouched, { desktop_features: {} }), [])
    assert.deepEqual(untouched, {})
  })

  test('managed status reports both switches', () => {
    assert.deepEqual(modelTierStatus({}), { modelTiers: false, modelTierMax: false })
    assert.deepEqual(modelTierStatus({ APEXNODES_MODEL_TIERS: '1' }), { modelTiers: true, modelTierMax: false })
    assert.deepEqual(modelTierStatus({ APEXNODES_MODEL_TIERS: '1', APEXNODES_MODEL_TIER_MAX: 'true' }), {
      modelTiers: true,
      modelTierMax: true
    })
  })
})

describe('the managed default model', () => {
  test('stays the pre-tier seed while the switch is off', () => {
    const endpoints = resolveApexEndpoints({})

    assert.equal(DEFAULT_MANAGED_MODEL, 'deepseek-flash')
    assert.equal(endpoints.model, DEFAULT_MANAGED_MODEL)
    assert.equal(endpoints.modelDisplay, MANAGED_MODEL_DISPLAY)
  })

  test('is the Flash alias, written without the -APEX sentinel, once tiers are on', () => {
    const endpoints = resolveApexEndpoints({ APEXNODES_MODEL_TIERS: '1' })

    assert.equal(TIER_DEFAULT_MANAGED_MODEL, 'apex-flash')
    assert.equal(endpoints.model, 'apex-flash')
    assert.equal(endpoints.modelDisplay, 'apex-flash')

    const block = buildManagedModelConfig('sk-test', { APEXNODES_MODEL_TIERS: '1' })

    assert.equal(block.default, 'apex-flash')
    assert.equal(block.custom_providers[0].model, 'apex-flash')
  })

  test('honors a server-sent tier alias only when tiers are on', () => {
    const on = { APEXNODES_MODEL_TIERS: '1' }

    assert.equal(buildManagedModelConfig('sk-test', on, { model: 'apex-pro' }).default, 'apex-pro')
    assert.equal(buildManagedModelConfig('sk-test', on, { model: 'deepseek-v4-pro' }).default, 'apex-flash')
    assert.equal(buildManagedModelConfig('sk-test', {}, { model: 'apex-pro' }).default, MANAGED_MODEL_DISPLAY)
  })

  test('aliases match the renderer twin', () => {
    const renderer = readFileSync(join(__dirname, '../src/lib/model-tiers.ts'), 'utf8')

    assert.deepEqual([...MODEL_TIER_ALIASES], ['apex-flash', 'apex-pro', 'apex-max'])

    for (const alias of MODEL_TIER_ALIASES) {
      assert.ok(isModelTierAlias(alias))
      assert.ok(renderer.includes(`'${alias}'`), `src/lib/model-tiers.ts lost ${alias}`)
    }

    assert.equal(isModelTierAlias('apex-flash-APEX'), false)
  })
})

describe('the boot migration to Flash', () => {
  const block = (provider: string, model: string, baseUrl = RELAY) =>
    `model:\n  default: ${model}\n  provider: ${provider}\n  base_url: ${baseUrl}\n  api_key: sk-test\nskills:\n  disabled: []\n`

  test.each([
    ['the -APEX seed on bare custom', block('custom', 'deepseek-flash-APEX'), 'deepseek-flash-APEX'],
    ['an old shelf pick on the named relay', block('custom:apex-nodes.com', 'kimi-k2.7-code'), 'kimi-k2.7-code'],
    ['a quoted id', block('custom', '"deepseek-v4-pro-APEX"'), 'deepseek-v4-pro-APEX']
  ])('moves %s', (_label, raw, from) => {
    const result = migrateManagedModelToTierYaml(raw, RELAY)

    assert.equal(result.changed, true)
    assert.equal(result.from, from)
    assert.match(result.next, /^ {2}default: apex-flash$/m)
    // Everything else in the block and the file is untouched.
    assert.equal(result.next.replace(/^ {2}default: .*$/m, ''), raw.replace(/^ {2}default: .*$/m, ''))
  })

  test.each([
    ['a tier already', block('custom:apex-nodes.com', 'apex-pro')],
    ['the user’s own provider', block('deepseek', 'deepseek-chat', 'https://api.deepseek.com/v1')],
    ['a custom endpoint elsewhere', block('custom', 'deepseek-flash-APEX', 'http://127.0.0.1:8080/v1')],
    ['MoA', block('moa', '__auto__', 'moa://local')],
    ['no model block', 'skills:\n  disabled: []\n']
  ])('leaves %s alone', (_label, raw) => {
    const result = migrateManagedModelToTierYaml(raw, RELAY)

    assert.equal(result.changed, false)
    assert.equal(result.next, raw)
  })

  test('the config heal step moves a pre-tier id only with a managed key and the switch on', () => {
    const raw = block('custom', 'deepseek-flash-APEX')
    const on = { APEXNODES_MODEL_TIERS: '1' }
    const fixed: string[] = []

    assert.equal(healManagedModelTier(raw, { baseUrl: RELAY, key: 'sk-test' }, RELAY, {}, fixed), raw, 'switch off')
    assert.equal(healManagedModelTier(raw, { baseUrl: RELAY }, RELAY, on, fixed), raw, 'no managed key')
    assert.deepEqual(fixed, [])

    const healed = healManagedModelTier(
      raw,
      { baseUrl: RELAY, key: 'sk-test' },
      'https://elsewhere.invalid/v1',
      on,
      fixed
    )

    assert.match(healed, /^ {2}default: apex-flash$/m, "the stored credential's base_url wins over the env relay")
    assert.deepEqual(fixed, ['model(tier:deepseek-flash-APEX→flash)'])
    assert.equal(healManagedModelTier(healed, { baseUrl: RELAY, key: 'sk-test' }, RELAY, on, fixed), healed)
    assert.equal(fixed.length, 1, 'a second pass changes nothing')
  })
})

describe('main.ts wiring', () => {
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

  test('settles the switches from the cached client config at module scope, before any seed', () => {
    const settle = main.search(/^applyModelTierSwitches\(process\.env, readClientConfigState\(\)\.payload\b/m)
    const ready = main.indexOf('app.whenReady().then(')

    assert.ok(settle > 0, 'the switch is never read from the platform config (or not at module scope)')
    assert.ok(settle < ready, 'the switch must be settled ahead of app.whenReady')
  })

  test('reports both switches in managed status', () => {
    const status = main.slice(main.indexOf("ipcMain.handle('hermes:managed:status'"))
    const body = status.slice(0, status.indexOf('\n})\n'))

    assert.match(body, /^\s+\.\.\.modelTierStatus\(process\.env\),/m)
  })

  test('runs the Flash migration step in the boot/watch config heal', () => {
    const heal = main.slice(main.indexOf('function healConfigYamlProductBlocks('))
    const body = heal.slice(0, heal.indexOf('\nfunction '))

    assert.match(body, /^\s+raw = healManagedModelTier\(raw, managed, endpoints\.relayBaseUrl, process\.env, fixed\)/m)
  })
})
