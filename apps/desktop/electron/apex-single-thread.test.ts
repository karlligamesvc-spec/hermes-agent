/**
 * hc-1015: the single-thread switch as main settles it at launch, and the
 * config heal's rule for the managed model while it is on (hc-1072, Kael
 * 2026-10-26: the user's tier is kept; it no longer goes back to Flash).
 *
 * Run with: npx vitest run electron/apex-single-thread.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

import { clientConfigForRenderer, desktopFeatureOnForLaunch } from './apex-desktop-features'
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
    assert.equal(singleThreadOnForLaunch({}, payload), on)
  })

  test('is hc-1014’s decision itself: the same answer for every install value and payload', () => {
    // hard rule 12: one rule for the switch. A second implementation here could
    // drift from hc-1014's; this pins the two together over the whole grid.
    const installs = [undefined, '1', '0', 'true', 'off', 'maybe', '']
    const payloads = [ON, OFF, { desktop_features: { single_thread: 'true' } }, null, [], { desktop_features: [] }]

    for (const value of installs) {
      for (const payload of payloads) {
        const env: Record<string, string | undefined> = value === undefined ? {} : { [INSTALL]: value }

        assert.equal(
          singleThreadOnForLaunch(env, payload),
          desktopFeatureOnForLaunch('single_thread', env, payload),
          `${INSTALL}=${String(value)} with ${JSON.stringify(payload)}`
        )
      }
    }
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

describe('the managed tier in single-thread mode (hc-1072: kept, not pinned to Flash)', () => {
  const block = (provider: string, model: string, baseUrl = RELAY) =>
    `model:\n  default: ${model}\n  provider: ${provider}\n  base_url: ${baseUrl}\n  api_key: sk-test\n`

  const managed = { baseUrl: RELAY, key: 'sk-test' }
  const singleThread = { [SINGLE_THREAD_ACTIVE_ENV]: '1' }
  const ALL = ['apex-flash', 'apex-max', 'apex-pro', 'apex-free']
  const FAST = ['apex-flash', 'apex-pro', 'apex-free']
  const FREE = ['apex-flash', 'apex-free']

  const heal = (raw: string, entitled: null | string[] = null) => {
    const fixed: string[] = []
    const next = healManagedModelTier(raw, managed, RELAY, singleThread, fixed, entitled)

    return { fixed, next }
  }

  test.each([
    ['a Pro pick, plan unknown', block('custom:apex-nodes.com', 'apex-pro'), null],
    ['a Max pick, plan unknown', block('custom', 'apex-max'), null],
    ['a Max pick on a plan with Max', block('custom', 'apex-max'), ALL],
    ['a Pro pick on a plan with Pro', block('custom:apex-nodes.com', 'apex-pro'), FAST],
    ['the default', block('custom', TIER_DEFAULT_MANAGED_MODEL), FREE],
    ['a tier in other case', block('custom', 'APEX-PRO'), FAST],
    ['a listing that names no tier (an older relay)', block('custom', 'apex-max'), ['deepseek-v4-pro']],
    ['the user’s own provider', block('deepseek', 'deepseek-chat', 'https://api.deepseek.com/v1'), FREE],
    ['a custom endpoint elsewhere', block('custom', 'apex-max', 'http://127.0.0.1:8080/v1'), FREE]
  ])('keeps %s', (_label, raw, entitled) => {
    const { fixed, next } = heal(raw, entitled)

    assert.equal(next, raw)
    assert.deepEqual(fixed, [])
  })

  test.each([
    ['the Flash -APEX seed', 'deepseek-flash-APEX', 'apex-flash'],
    ['the hc-906 Flash seed', 'deepseek-v4-flash-APEX', 'apex-flash'],
    ['the 06-27 Pro seed', 'deepseek-v4-pro-APEX', 'apex-pro'],
    ['an old shelf Pro pick', 'deepseek-v4-pro', 'apex-pro'],
    ['Pro’s first upstream', 'mimo-v2.6-pro', 'apex-pro'],
    ['an old shelf pick no tier ran', 'kimi-k2.7-code', 'apex-flash'],
    ['a quoted old id', '"deepseek-v4-pro-APEX"', 'apex-pro']
  ])('moves %s to the tier it stands for', (_label, model, to) => {
    const raw = block('custom:apex-nodes.com', model)
    const { fixed, next } = heal(raw, ALL)

    assert.match(next, new RegExp(`^ {2}default: ${to}$`, 'm'))
    assert.deepEqual(fixed, [`model(single-thread:${model.replace(/"/g, '')}→${to.replace('apex-', '')})`])
    assert.equal(next.replace(/^ {2}default: .*$/m, ''), raw.replace(/^ {2}default: .*$/m, ''))
    assert.equal(heal(next, ALL).next, next, 'a second pass changes nothing')
  })

  test.each([
    ['Max on a plan up to Pro', 'apex-max', FAST, 'apex-pro'],
    ['Max on the free plan', 'apex-max', FREE, 'apex-flash'],
    ['Pro on the free plan', 'apex-pro', FREE, 'apex-flash'],
    ['an old Pro id on the free plan', 'deepseek-v4-pro-APEX', FREE, 'apex-flash'],
    ['Pro on a listing without Flash or Pro', 'apex-pro', ['apex-max'], 'apex-flash']
  ])('drops %s to the strongest tier the plan grants', (_label, model, entitled, to) => {
    const raw = block('custom', model)
    const { fixed, next } = heal(raw, entitled)

    assert.match(next, new RegExp(`^ {2}default: ${to}$`, 'm'))
    assert.deepEqual(fixed, [`model(single-thread:${model}→${to.replace('apex-', '')})`])
    assert.equal(heal(next, entitled).next, next, 'a second pass changes nothing')
  })

  test('needs a managed credential, and leaves tier mode’s rule alone', () => {
    const pro = block('custom:apex-nodes.com', 'apex-pro')
    const seed = block('custom', 'deepseek-v4-pro-APEX')
    const fixed: string[] = []

    assert.equal(healManagedModelTier(pro, { baseUrl: RELAY }, RELAY, singleThread, fixed, FREE), pro, 'no managed key')
    assert.equal(healManagedModelTier(pro, managed, RELAY, {}, fixed, FREE), pro, 'both off')
    assert.deepEqual(fixed, [])
    // Tier mode alone: a tier stays whatever the listing says, every old id goes to Flash.
    assert.equal(healManagedModelTier(pro, managed, RELAY, { APEXNODES_MODEL_TIERS: '1' }, fixed, FREE), pro)
    assert.match(
      healManagedModelTier(seed, managed, RELAY, { APEXNODES_MODEL_TIERS: '1' }, fixed, ALL),
      /default: apex-flash$/m
    )
    assert.deepEqual(fixed, ['model(tier:deepseek-v4-pro-APEX→flash)'])
    assert.equal(migrateManagedModelToTierYaml(pro, RELAY).changed, false, 'the tier migration keeps its tiers')
  })
})
