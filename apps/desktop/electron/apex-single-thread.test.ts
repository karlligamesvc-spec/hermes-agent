/**
 * hc-1015: the single-thread switch as main settles it at launch, and the
 * config heal that pins the managed model to the default tier alias while it
 * is on (decision 5: the user sees no tier; the shell sends the default).
 *
 * Run with: npx vitest run electron/apex-single-thread.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  isSingleThreadActive,
  SINGLE_THREAD_ACTIVE_ENV,
  singleThreadFromClientConfig,
  singleThreadOnForLaunch
} from './apex-single-thread'

const RELAY = DEFAULT_RELAY_BASE_URL
const ON = { desktop_features: { single_thread: true } }
const OFF = { desktop_features: {} }
const INSTALL = 'APEXNODES_SINGLE_THREAD'

describe('the switch for this launch', () => {
  test.each([
    [ON, true],
    [{ desktop_features: { single_thread: 'true' } }, false],
    [{ desktop_features: { single_thread: 1 } }, false],
    [{ desktop_features: { model_tiers: true } }, false],
    [{ desktop_features: [] }, false],
    [[], false],
    [null, false]
  ])('reads the platform payload %j as %s', (payload, on) => {
    assert.equal(singleThreadFromClientConfig(payload), on)
  })

  test.each([
    ['the platform alone', {}, ON, true],
    ['nothing on', {}, OFF, false],
    ['this install on, platform off', { [INSTALL]: '1' }, OFF, true],
    ['this install off, platform on', { [INSTALL]: '0' }, ON, false],
    ['an unreadable install value leaves it to the platform', { [INSTALL]: 'maybe' }, ON, true]
  ])('decides as hc-1014 does: %s', (_label, env, payload, on) => {
    assert.equal(singleThreadOnForLaunch(env, payload), on)
  })

  test('tells the engine through its own variable and never writes hc-1014’s input', () => {
    const lines: string[] = []
    const env: Record<string, string | undefined> = {}

    assert.equal(
      applySingleThreadSwitch(env, ON, line => lines.push(line)),
      true
    )
    assert.equal(env[SINGLE_THREAD_ACTIVE_ENV], '1')
    assert.equal(isSingleThreadActive(env), true)
    assert.equal(env[INSTALL], undefined)
    assert.deepEqual(lines, ['[client-config] APEX_SINGLE_THREAD_ACTIVE=1 (desktop_features.single_thread)'])
    // The renderer's install switches stay exactly what this install set: none.
    assert.deepEqual(clientConfigForRenderer({ appliedVersion: 3, payload: ON, version: 3 }, env).installSwitches, {})
  })

  test('clears a stale signal when the switch is off for this launch', () => {
    const env: Record<string, string | undefined> = { [INSTALL]: '0', [SINGLE_THREAD_ACTIVE_ENV]: '1' }

    assert.equal(applySingleThreadSwitch(env, ON), false)
    assert.equal(env[SINGLE_THREAD_ACTIVE_ENV], undefined)
    assert.equal(env[INSTALL], '0')
    assert.equal(isSingleThreadActive(env), false)
  })

  test('settles with the tier switches in one launch-time call', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(
      applyDesktopFeatureSwitches(env, { desktop_features: { model_tiers: true, single_thread: true } }),
      ['APEXNODES_MODEL_TIERS', SINGLE_THREAD_ACTIVE_ENV]
    )
    assert.equal(env.APEXNODES_MODEL_TIERS, '1')
    assert.equal(env[SINGLE_THREAD_ACTIVE_ENV], '1')
  })
})

describe('main never writes hc-1014’s per-install switch', () => {
  // APEXNODES_SINGLE_THREAD is an input (hc-1014: 1 on, 0 forced off, ahead of
  // the platform; read into installSwitches). Writing it from main would turn a
  // platform value into a per-install override and feed it back into the read.
  test.each([
    ['unset, platform on', undefined, ON],
    ['unset, platform off', undefined, OFF],
    ['forced off, platform on', '0', ON],
    ['forced on, platform off', '1', OFF],
    ['an unreadable value', 'maybe', ON]
  ])('the launch-time call main makes leaves it as it was: %s', (_label, before, payload) => {
    const env: Record<string, string | undefined> = before === undefined ? {} : { [INSTALL]: before }

    applyDesktopFeatureSwitches(env, payload)

    assert.equal(env[INSTALL], before)
    assert.equal(INSTALL in env, before !== undefined)
  })

  test('no main-process module assigns or deletes it', () => {
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const name = /APEXNODES_SINGLE_THREAD|DESKTOP_FEATURE_ENV/

    const assigns =
      /(APEXNODES_SINGLE_THREAD['"]?\]?|DESKTOP_FEATURE_ENV(?:\.\w+|\[[^\]]*\])\])\s*(?:=(?!=)|\?\?=|\|\|=)/

    const deletes = /delete\s+[^\n;]*(APEXNODES_SINGLE_THREAD|DESKTOP_FEATURE_ENV)/

    const offenders = readdirSync(__dirname)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
      .flatMap(file =>
        strip(readFileSync(join(__dirname, file), 'utf8'))
          .split('\n')
          .filter(line => name.test(line) && (assigns.test(line) || deletes.test(line)))
          .map(line => `${file}: ${line.trim()}`)
      )

    assert.deepEqual(offenders, [])
    // The guard can see a write: the injected form it must catch.
    assert.ok(assigns.test("  env.APEXNODES_SINGLE_THREAD = '1'"))
    assert.ok(assigns.test("  env[DESKTOP_FEATURE_ENV.single_thread] = '1'"))
    assert.ok(deletes.test('  delete process.env.APEXNODES_SINGLE_THREAD'))
  })
})

describe('the default tier alias, pinned in single-thread mode', () => {
  const block = (provider: string, model: string, baseUrl = RELAY) =>
    `model:\n  default: ${model}\n  provider: ${provider}\n  base_url: ${baseUrl}\n  api_key: sk-test\n`

  const managed = { baseUrl: RELAY, key: 'sk-test' }
  const singleThread = { [SINGLE_THREAD_ACTIVE_ENV]: '1' }

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
