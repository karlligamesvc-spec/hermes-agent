/**
 * The account's credentials Desktop injects into every process it spawns
 * (backend, each assistant's engine, messaging gateway) are listed once, in
 * apex_overlay/cron_account_env.py: ACCOUNT_ENV_NAMES are the account's and
 * PER_ASSISTANT_GATES stay each assistant's own policy. Two engine seams lend
 * the account's names to a profile from that one list:
 * - hc-1169 cron_account_env: a cron fire, when the process serves several
 *   assistants;
 * - hc-1166 hosted_profiles: every assistant one engine hosts (single-engine
 *   switch).
 * Every name Desktop injects for the account has to be in exactly one of the
 * two tuples, or a cron job or a hosted assistant loses a credential the
 * moment Desktop starts injecting a new one.
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

  // Whatever the backend env carries only because an account is signed in (web search, and since
  // hc-1214 web extraction), not a fixed prefix: a new account-bound name cannot slip past.
  const signedOut = new Set(Object.keys(backendEnv()))
  const web = Object.keys(backendEnv('relay-key')).filter(name => !signedOut.has(name))

  return [...PLATFORM_TOOL_ENV_KEYS, ...Object.keys(feishu), ...imEntry, ...web]
}

function backendEnv(webSearchApiKey?: string) {
  return buildDesktopBackendEnv({
    currentEnv: {},
    hermesHome: '/apex/home',
    platform: 'darwin',
    runtimeRoot: '/apex/runtime',
    venvRoot: '/apex/runtime/venv',
    webSearchApiKey
  })
}

test('every account name Desktop injects either reaches cron fires or stays a gate of each assistant', () => {
  const shared = overlayNames('ACCOUNT_ENV_NAMES')
  const gates = overlayNames('PER_ASSISTANT_GATES')
  const classified = [...shared, ...gates]

  assert.equal(new Set(classified).size, classified.length, 'a name is listed twice, or as both')
  assert.deepEqual([...new Set(desktopAccountNames())].sort(), classified.sort())
})

test('cron fires get every credential the platform tools, web search and web extraction are spawned with', () => {
  const shared = new Set(overlayNames('ACCOUNT_ENV_NAMES'))
  const web = ['SEARXNG_URL', 'SEARXNG_API_KEY', 'FIRECRAWL_API_URL', 'FIRECRAWL_API_KEY']

  assert.deepEqual([...PLATFORM_TOOL_ENV_KEYS, ...web].filter(name => !shared.has(name)), [])
})

test('the web pairs (search, extraction) are only injected for a signed-in account', () => {
  const web = /^(SEARXNG|FIRECRAWL)_/

  assert.deepEqual(Object.keys(backendEnv()).filter(name => web.test(name)), [])
  assert.deepEqual(Object.keys(backendEnv('relay-key')).filter(name => web.test(name)).sort(), [
    'FIRECRAWL_API_KEY',
    'FIRECRAWL_API_URL',
    'SEARXNG_API_KEY',
    'SEARXNG_URL'
  ])
})
