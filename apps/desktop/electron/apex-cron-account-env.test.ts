/**
 * hc-1169: a cron job fires with the signed-in account's credentials in every
 * Desktop process (backend, each assistant's engine, messaging gateway), even
 * when that process serves several assistants. The engine's APEX overlay
 * (apex_overlay/cron_account_env.py) adds the names in ACCOUNT_ENV_NAMES to a
 * fire's scope and never the gates in PER_ASSISTANT_GATES. Every name Desktop
 * injects for the account has to be in exactly one of the two, or cron jobs
 * lose a credential the moment Desktop starts injecting a new one.
 *
 * Run with: npx vitest run electron/apex-cron-account-env.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { test } from 'vitest'

import { buildFeishuBackendEnv } from './apex-feishu'
import { CHANNEL_ENV_DESCRIPTORS } from './apex-im-entry'
import { PLATFORM_TOOL_ENV_KEYS } from './apex-platform-tools'
import { buildDesktopBackendEnv } from './backend-env'

const OVERLAY = resolve(__dirname, '../../../apex_overlay/cron_account_env.py')

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

test('every account name Desktop injects either reaches cron fires or stays a gate of each assistant', () => {
  const shared = overlayNames('ACCOUNT_ENV_NAMES')
  const gates = overlayNames('PER_ASSISTANT_GATES')
  const classified = [...shared, ...gates]

  assert.equal(new Set(classified).size, classified.length, 'a name is listed twice, or as both')
  assert.deepEqual([...new Set(desktopAccountNames())].sort(), classified.sort())
})

test('cron fires get every credential the platform tools and web search are spawned with', () => {
  const shared = new Set(overlayNames('ACCOUNT_ENV_NAMES'))

  assert.deepEqual(
    [...PLATFORM_TOOL_ENV_KEYS, 'SEARXNG_URL', 'SEARXNG_API_KEY'].filter(name => !shared.has(name)),
    []
  )
})
