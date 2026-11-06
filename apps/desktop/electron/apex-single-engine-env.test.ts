/**
 * hc-1166: with one engine hosting every assistant, the engine's APEX overlay
 * (apex_overlay/hosted_profiles.py) lets the assistants other than APEX read
 * the account's credentials from the engine's environment (ACCOUNT_ENV_NAMES)
 * and keeps each assistant's authorization gates its own
 * (PER_ASSISTANT_GATES). Every name Desktop injects for the account has to be
 * in exactly one of the two, or an assistant loses a tool the moment one side
 * adds a key.
 *
 * Run with: npx vitest run electron/apex-single-engine-env.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { test } from 'vitest'

import { buildFeishuBackendEnv } from './apex-feishu'
import { CHANNEL_ENV_DESCRIPTORS } from './apex-im-entry'
import { PLATFORM_TOOL_ENV_KEYS } from './apex-platform-tools'
import { buildDesktopBackendEnv } from './backend-env'

const OVERLAY = resolve(__dirname, '../../../apex_overlay/hosted_profiles.py')

function overlayNames(tuple: 'ACCOUNT_ENV_NAMES' | 'PER_ASSISTANT_GATES'): string[] {
  const blocks = [...readFileSync(OVERLAY, 'utf8').matchAll(new RegExp(`^${tuple} = \\(([^)]*)\\)`, 'gm'))]

  assert.equal(blocks.length, 1, `${tuple} should be defined once`)

  return [...blocks[0][1].matchAll(/"([A-Z0-9_]+)"/g)].map(match => match[1])
}

function desktopAccountNames(): string[] {
  const feishu = buildFeishuBackendEnv({ appId: 'app', appSecret: 'secret', domain: 'feishu' })

  const imEntry = Object.values(CHANNEL_ENV_DESCRIPTORS).flatMap((descriptor: any) =>
    descriptor.fields.map((field: any) => field.key)
  )

  const webSearch = Object.keys(
    buildDesktopBackendEnv({
      currentEnv: {},
      hermesHome: '/apex/home',
      platform: 'darwin',
      runtimeRoot: '/apex/runtime',
      venvRoot: '/apex/runtime/venv',
      webSearchApiKey: 'relay-key'
    })
  ).filter(name => name.startsWith('SEARXNG_'))

  return [...PLATFORM_TOOL_ENV_KEYS, ...Object.keys(feishu), ...imEntry, ...webSearch]
}

test('every account name Desktop injects is either shared with the hosted assistants or a gate of their own', () => {
  const shared = overlayNames('ACCOUNT_ENV_NAMES')
  const gates = overlayNames('PER_ASSISTANT_GATES')
  const classified = [...shared, ...gates]

  assert.equal(new Set(classified).size, classified.length, 'a name is listed twice, or as both')
  assert.deepEqual([...new Set(desktopAccountNames())].sort(), classified.sort())
})

test('the shared names cover what the platform tools are spawned with', () => {
  const shared = new Set(overlayNames('ACCOUNT_ENV_NAMES'))

  assert.deepEqual(
    PLATFORM_TOOL_ENV_KEYS.filter(name => !shared.has(name)),
    []
  )
})

test('the web search pair is only injected for a signed-in account', () => {
  const signedOut = buildDesktopBackendEnv({
    currentEnv: {},
    hermesHome: '/apex/home',
    platform: 'darwin',
    runtimeRoot: '/apex/runtime',
    venvRoot: '/apex/runtime/venv'
  })

  assert.equal(Object.keys(signedOut).filter(name => name.startsWith('SEARXNG_')).length, 0)
})
