/**
 * hc-1086: the relay (接力) switch as main settles it at launch, and the engine
 * signal every profile's engine reads (R3's prompt sections).
 *
 * Run with: npx vitest run electron/apex-multi-bot-handoff.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { clientConfigForRenderer, desktopFeatureInstallSwitches } from './apex-desktop-features'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import {
  applyMultiBotHandoffSwitch,
  MULTI_BOT_HANDOFF_ACTIVE_ENV,
  multiBotHandoffOnForLaunch
} from './apex-multi-bot-handoff'
import { MULTI_BOT_ACTIVE_ENV } from './apex-profile-homes'
import { SINGLE_THREAD_ACTIVE_ENV } from './apex-single-thread'

const INSTALL = 'APEXNODES_MULTI_BOT_HANDOFF'
const ALL = { desktop_features: { multi_bot: true, multi_bot_handoff: true, single_thread: true } }
const SEVERAL = { desktop_features: { multi_bot: true, single_thread: true } }

describe('the switch for this launch', () => {
  test.each([
    ['all three on from the platform', {}, ALL, true],
    [
      'relay without several assistants',
      {},
      { desktop_features: { multi_bot_handoff: true, single_thread: true } },
      false
    ],
    ['relay without single-thread', {}, { desktop_features: { multi_bot: true, multi_bot_handoff: true } }, false],
    ['several assistants alone', {}, SEVERAL, false],
    ['a non-literal true', {}, { desktop_features: { ...SEVERAL.desktop_features, multi_bot_handoff: 'true' } }, false],
    ['nothing', {}, null, false],
    ['this install on, several assistants from the platform', { [INSTALL]: '1' }, SEVERAL, true],
    [
      'this install on, several assistants off',
      { [INSTALL]: '1' },
      { desktop_features: { single_thread: true } },
      false
    ],
    ['all from this install', { [INSTALL]: '1', APEXNODES_MULTI_BOT: '1', APEXNODES_SINGLE_THREAD: '1' }, null, true],
    ['this install off, platform on', { [INSTALL]: '0' }, ALL, false],
    ['several assistants forced off by this install', { APEXNODES_MULTI_BOT: '0' }, ALL, false],
    ['single-thread forced off by this install', { APEXNODES_SINGLE_THREAD: '0' }, ALL, false],
    ['an unreadable install value leaves it to the platform', { [INSTALL]: 'maybe' }, ALL, true]
  ])('%s', (_label, env, payload, on) => {
    assert.equal(multiBotHandoffOnForLaunch(env, payload), on)
  })

  test('the install switch reaches the renderer beside the stored payload', () => {
    assert.deepEqual(desktopFeatureInstallSwitches({ [INSTALL]: '1' }), { multi_bot_handoff: true })
    assert.deepEqual(desktopFeatureInstallSwitches({ [INSTALL]: 'off' }), { multi_bot_handoff: false })
    assert.deepEqual(clientConfigForRenderer({ appliedVersion: 6, payload: SEVERAL, version: 6 }, { [INSTALL]: '1' }), {
      appliedVersion: 6,
      installSwitches: { multi_bot_handoff: true },
      payload: SEVERAL,
      version: 6
    })
  })

  test('tells the engine through its own variable and never writes the install switch', () => {
    const lines: string[] = []
    const env: Record<string, string | undefined> = {}

    assert.equal(
      applyMultiBotHandoffSwitch(env, ALL, line => lines.push(line)),
      true
    )
    assert.equal(env[MULTI_BOT_HANDOFF_ACTIVE_ENV], '1')
    assert.equal(INSTALL in env, false)
    assert.deepEqual(lines, ['[client-config] APEX_MULTI_BOT_HANDOFF_ACTIVE=1 (desktop_features.multi_bot_handoff)'])
  })

  test('clears a stale signal when it is off for this launch', () => {
    const env: Record<string, string | undefined> = { [INSTALL]: '0', [MULTI_BOT_HANDOFF_ACTIVE_ENV]: '1' }

    assert.equal(applyMultiBotHandoffSwitch(env, ALL), false)
    assert.deepEqual(env, { [INSTALL]: '0' })
  })

  test('is settled with the other launch switches, after several assistants', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(applyDesktopFeatureSwitches(env, ALL), [
      SINGLE_THREAD_ACTIVE_ENV,
      MULTI_BOT_ACTIVE_ENV,
      MULTI_BOT_HANDOFF_ACTIVE_ENV
    ])
    assert.equal(env[MULTI_BOT_HANDOFF_ACTIVE_ENV], '1')
    // Several assistants switched off on the next launch: the stale signal goes with it.
    assert.deepEqual(
      applyDesktopFeatureSwitches(env, { desktop_features: { multi_bot_handoff: true, single_thread: true } }),
      [SINGLE_THREAD_ACTIVE_ENV]
    )
    assert.equal(env[MULTI_BOT_HANDOFF_ACTIVE_ENV], undefined)
  })
})

describe('launch switches with the relay on (new; the off cases are in apex-multi-bot-handoff-identity.test.ts)', () => {
  test('main adds only APEX_MULTI_BOT_HANDOFF_ACTIVE to what several assistants already set', async () => {
    const launch = (env: Record<string, string | undefined>, payload: unknown) => {
      const spawnEnv = { ...env }
      const lines: string[] = []
      const set = applyDesktopFeatureSwitches(spawnEnv, payload, line => lines.push(line))

      return { env: spawnEnv, lines, set }
    }

    const cases = {
      'all three from the platform': launch({}, ALL),
      'relay from this install': launch({ [INSTALL]: '1' }, SEVERAL),
      'all from this install': launch({ [INSTALL]: '1', APEXNODES_MULTI_BOT: '1', APEXNODES_SINGLE_THREAD: '1' }, null)
    }

    await expect(`${JSON.stringify(cases, null, 2)}\n`).toMatchFileSnapshot(
      './__identity__/multi-bot-handoff/launch-env-on.json'
    )
  })
})

describe('every engine sees it', () => {
  test('the primary and every pool backend spawn with process.env spread in (main settles it before any spawn)', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

    assert.match(main, /^applyDesktopFeatureSwitches\(process\.env, readClientConfigState\(\)\.payload\b/m)
    assert.equal((main.match(/env: \{ \.\.\.process\.env, HERMES_HOME, \.\.\.\(?backend\.env/g) ?? []).length, 2)
  })
})

describe('main never writes the per-install switch', () => {
  test('no main-process module assigns or deletes APEXNODES_MULTI_BOT_HANDOFF', () => {
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const assigns = /APEXNODES_MULTI_BOT_HANDOFF['"]?\]?\s*(?:=(?!=)|\?\?=|\|\|=)/
    const deletes = /delete\s+[^\n;]*APEXNODES_MULTI_BOT_HANDOFF/

    const offenders = readdirSync(__dirname)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
      .flatMap(file =>
        strip(readFileSync(join(__dirname, file), 'utf8'))
          .split('\n')
          .filter(line => assigns.test(line) || deletes.test(line))
          .map(line => `${file}: ${line.trim()}`)
      )

    assert.deepEqual(offenders, [])
    assert.ok(assigns.test("  env.APEXNODES_MULTI_BOT_HANDOFF = '1'"))
    assert.ok(deletes.test('  delete process.env.APEXNODES_MULTI_BOT_HANDOFF'))
  })
})
