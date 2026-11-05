/**
 * hc-1122: the launch switch main settles from `desktop_features.chatcut`. The off
 * path is pinned against fork main by apex-chatcut-identity.test.ts.
 *
 * Run with: npx vitest run electron/apex-chatcut.test.ts --project electron
 */

import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { applyChatcutSwitch, CHATCUT_ACTIVE_ENV } from './apex-chatcut'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'

const ON = { desktop_features: { chatcut: true } }

describe('the launch switch', () => {
  test('the platform turns it on with a literal true, and it is logged once', () => {
    const env: Record<string, string | undefined> = {}
    const lines: string[] = []

    assert.equal(applyChatcutSwitch(env, ON, line => lines.push(line)), true)
    assert.equal(env[CHATCUT_ACTIVE_ENV], '1')
    assert.deepEqual(lines, ['[client-config] APEX_CHATCUT_ACTIVE=1 (desktop_features.chatcut)'])
  })

  test.each([
    ['no config', null],
    ['no flag', { desktop_features: {} }],
    ['false', { desktop_features: { chatcut: false } }],
    ['a string', { desktop_features: { chatcut: 'true' } }],
    ['a number', { desktop_features: { chatcut: 1 } }],
    ['a top-level key', { chatcut: true }]
  ])('%s leaves it off', (_label, payload) => {
    const env: Record<string, string | undefined> = {}

    assert.equal(applyChatcutSwitch(env, payload), false)
    assert.equal(CHATCUT_ACTIVE_ENV in env, false)
  })

  test('this install wins in both directions', () => {
    const on: Record<string, string | undefined> = { APEXNODES_CHATCUT: '1' }
    const off: Record<string, string | undefined> = { APEXNODES_CHATCUT: '0' }

    assert.equal(applyChatcutSwitch(on, null), true)
    assert.equal(applyChatcutSwitch(off, ON), false)
    assert.equal(off[CHATCUT_ACTIVE_ENV], undefined)
  })

  test('off removes a value inherited from the environment: it is an output, never an input', () => {
    const env: Record<string, string | undefined> = { [CHATCUT_ACTIVE_ENV]: '1' }

    applyChatcutSwitch(env, null)

    assert.equal(CHATCUT_ACTIVE_ENV in env, false)
  })

  test('the launch settles it with the other switches', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(applyDesktopFeatureSwitches(env, ON), [CHATCUT_ACTIVE_ENV])
    assert.equal(env[CHATCUT_ACTIVE_ENV], '1')
  })
})
