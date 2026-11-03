/**
 * hc-1077: the several-assistants switch as main settles it at launch, and the
 * engine signal every profile's engine reads.
 *
 * Run with: npx vitest run electron/apex-multi-bot.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

import { clientConfigForRenderer, desktopFeatureInstallSwitches } from './apex-desktop-features'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import { applyMultiBotSwitch, multiBotOnForLaunch } from './apex-multi-bot'
import { MULTI_BOT_ACTIVE_ENV } from './apex-profile-homes'
import { SINGLE_THREAD_ACTIVE_ENV } from './apex-single-thread'

const INSTALL = 'APEXNODES_MULTI_BOT'
const BOTH = { desktop_features: { multi_bot: true, single_thread: true } }
const MULTI_ONLY = { desktop_features: { multi_bot: true } }
const SINGLE_ONLY = { desktop_features: { single_thread: true } }

describe('the switch for this launch', () => {
  test.each([
    ['both on from the platform', {}, BOTH, true],
    ['multi_bot without single-thread', {}, MULTI_ONLY, false],
    ['single-thread alone', {}, SINGLE_ONLY, false],
    ['a non-literal true', {}, { desktop_features: { multi_bot: 'true', single_thread: true } }, false],
    ['nothing', {}, null, false],
    ['this install on, single-thread from the platform', { [INSTALL]: '1' }, SINGLE_ONLY, true],
    ['this install on, single-thread off', { [INSTALL]: '1' }, null, false],
    ['both from this install', { [INSTALL]: '1', APEXNODES_SINGLE_THREAD: '1' }, null, true],
    ['this install off, platform on', { [INSTALL]: '0' }, BOTH, false],
    ['single-thread forced off by this install', { APEXNODES_SINGLE_THREAD: '0' }, BOTH, false],
    ['an unreadable install value leaves it to the platform', { [INSTALL]: 'maybe' }, BOTH, true]
  ])('%s', (_label, env, payload, on) => {
    assert.equal(multiBotOnForLaunch(env, payload), on)
  })

  test('the install switch reaches the renderer beside the stored payload', () => {
    assert.deepEqual(desktopFeatureInstallSwitches({ [INSTALL]: '1' }), { multi_bot: true })
    assert.deepEqual(desktopFeatureInstallSwitches({ [INSTALL]: 'off' }), { multi_bot: false })
    assert.deepEqual(
      clientConfigForRenderer({ appliedVersion: 4, payload: SINGLE_ONLY, version: 4 }, { [INSTALL]: '1' }),
      { appliedVersion: 4, installSwitches: { multi_bot: true }, payload: SINGLE_ONLY, version: 4 }
    )
  })

  test('tells the engine through its own variable and never writes the install switch', () => {
    const lines: string[] = []
    const env: Record<string, string | undefined> = {}

    assert.equal(
      applyMultiBotSwitch(env, BOTH, line => lines.push(line)),
      true
    )
    assert.equal(env[MULTI_BOT_ACTIVE_ENV], '1')
    assert.equal(INSTALL in env, false)
    assert.deepEqual(lines, ['[client-config] APEX_MULTI_BOT_ACTIVE=1 (desktop_features.multi_bot)'])
  })

  test('clears a stale signal when it is off for this launch', () => {
    const env: Record<string, string | undefined> = { [INSTALL]: '0', [MULTI_BOT_ACTIVE_ENV]: '1' }

    assert.equal(applyMultiBotSwitch(env, BOTH), false)
    assert.deepEqual(env, { [INSTALL]: '0' })
  })

  test('is settled with the other launch switches, after single-thread', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(applyDesktopFeatureSwitches(env, BOTH), [SINGLE_THREAD_ACTIVE_ENV, MULTI_BOT_ACTIVE_ENV])
    assert.equal(env[MULTI_BOT_ACTIVE_ENV], '1')
    assert.deepEqual(applyDesktopFeatureSwitches(env, SINGLE_ONLY), [SINGLE_THREAD_ACTIVE_ENV])
    assert.equal(env[MULTI_BOT_ACTIVE_ENV], undefined)
  })
})

describe('every engine sees it', () => {
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

  test('main settles the switches into process.env before app.whenReady', () => {
    assert.match(main, /^applyDesktopFeatureSwitches\(process\.env, readClientConfigState\(\)\.payload\b/m)
  })

  test('the primary and every pool backend spawn with process.env spread in', () => {
    // A backend spawned with a hand-built env would miss APEX_MULTI_BOT_ACTIVE and
    // call itself APEX in a named profile (hc-1082 reads it there).
    const spawns = main.match(/env: \{ \.\.\.process\.env, HERMES_HOME, \.\.\.\(?backend\.env/g) ?? []

    assert.equal(spawns.length, 2)
  })
})

describe('main never writes the per-install switch', () => {
  test('no main-process module assigns or deletes APEXNODES_MULTI_BOT', () => {
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const assigns = /APEXNODES_MULTI_BOT['"]?\]?\s*(?:=(?!=)|\?\?=|\|\|=)/
    const deletes = /delete\s+[^\n;]*APEXNODES_MULTI_BOT/

    const offenders = readdirSync(__dirname)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
      .flatMap(file =>
        strip(readFileSync(join(__dirname, file), 'utf8'))
          .split('\n')
          .filter(line => assigns.test(line) || deletes.test(line))
          .map(line => `${file}: ${line.trim()}`)
      )

    assert.deepEqual(offenders, [])
    assert.ok(assigns.test("  env.APEXNODES_MULTI_BOT = '1'"))
    assert.ok(deletes.test('  delete process.env.APEXNODES_MULTI_BOT'))
  })
})
