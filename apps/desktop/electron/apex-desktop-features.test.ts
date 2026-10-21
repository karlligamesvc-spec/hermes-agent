/**
 * hc-1014: the install switch for `desktop_features.single_thread`, and the
 * client-config answer that carries it to the renderer.
 *
 * Run with: npx vitest run electron/apex-desktop-features.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

import { clientConfigForRenderer, desktopFeatureInstallSwitches, envSwitch } from './apex-desktop-features'

const STATE = {
  appliedVersion: 3,
  payload: { desktop_features: { single_thread: true, daily_ideas: true } },
  version: 4
}

describe('hc-1014 install switches for desktop_features', () => {
  test.each([
    ['1', true],
    [' TRUE ', true],
    ['on', true],
    ['0', false],
    ['off', false],
    ['', null],
    ['maybe', null],
    [undefined, null]
  ])('APEXNODES_SINGLE_THREAD=%j reads as %j', (raw, expected) => {
    assert.equal(envSwitch(raw), expected)
    assert.deepEqual(
      desktopFeatureInstallSwitches({ APEXNODES_SINGLE_THREAD: raw }),
      expected === null ? {} : { single_thread: expected }
    )
  })

  test('the renderer gets the stored payload untouched, with the switches beside it', () => {
    const answer = clientConfigForRenderer(STATE, { APEXNODES_SINGLE_THREAD: '0' })

    assert.deepEqual(answer, { ...STATE, installSwitches: { single_thread: false } })
    assert.equal(answer.payload, STATE.payload)
  })

  test('no switch set: the platform decides', () => {
    assert.deepEqual(clientConfigForRenderer(STATE, {}).installSwitches, {})
  })

  test('main answers hermes:clientConfig:get through clientConfigForRenderer with process.env', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

    assert.match(
      main,
      /ipcMain\.handle\('hermes:clientConfig:get', async \(\) => clientConfigForRenderer\(readClientConfigState\(\), process\.env\)\)/
    )
  })
})
