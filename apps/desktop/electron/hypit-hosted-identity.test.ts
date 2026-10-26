/**
 * APEX-hosted Hypit generation (`desktop_features.hypihub_apex`) is off by
 * default. While it is off, the launch env main settles and the env the `hypit`
 * wrapper hands to Hypit must be what fork main produced before the switch
 * existed (recorded on fork main 024c8151, before the feature code).
 *
 * Run with: npx vitest run electron/hypit-hosted-identity.test.ts --project electron
 */

import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { hypitEnvironment } from '../../../apex_overlay/hypit_environment.mjs'

import { applyDesktopFeatureSwitches } from './apex-model-tiers'

const OFF_PAYLOADS: [string, unknown][] = [
  ['no client config', null],
  ['no features', { desktop_features: {} }],
  ['string true', { desktop_features: { hypihub_apex: 'true' } }],
  ['number 1', { desktop_features: { hypihub_apex: 1 } }],
  ['explicit false', { desktop_features: { hypihub_apex: false } }],
  ['top-level key', { hypihub_apex: true }]
]

const ENGINE_ENV = {
  APEX_HYPIHUB_TOKEN: undefined,
  HOME: '/Users/test',
  PATH: '/usr/bin',
  TOOLS_GATEWAY_BASE: 'https://api.apex-nodes.com',
  TOOLS_GATEWAY_KEY: 'fake-agent-key-not-a-secret'
}

describe('launch switches while hosted Hypit generation is off', () => {
  test.each(OFF_PAYLOADS)('%s leaves the launch env as main left it', (_name, payload) => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    const lines: string[] = []

    expect(applyDesktopFeatureSwitches(env, payload, line => lines.push(line))).toEqual([])
    expect(env).toEqual({ PATH: '/usr/bin' })
    expect(lines).toEqual([])
  })
})

describe('the wrapper env while hosted Hypit generation is off', () => {
  test.each([
    ['unset', {}],
    ['zero', { APEX_HYPIHUB_ACTIVE: '0' }],
    ['word true', { APEX_HYPIHUB_ACTIVE: 'true' }]
  ])('switch %s: Hypit gets the env main gave it', (_name, switchEnv) => {
    const source: Record<string, string | undefined> = { ...ENGINE_ENV, ...switchEnv }
    delete source.APEX_HYPIHUB_TOKEN
    const env = hypitEnvironment(source, '/runtime', '/runtime/node/bin/node', 'https://cos/registry')

    expect(env).toEqual({
      ...source,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://cos/registry',
      npm_config_update_notifier: 'false',
      PATH: [path.join('/runtime', '.runtime/bin'), path.dirname('/runtime/node/bin/node'), '/usr/bin'].join(
        path.delimiter
      ),
      PUPPETEER_SKIP_DOWNLOAD: 'true',
      PYTHONPATH: '/runtime'
    })
    expect(Object.keys(env)).not.toContain('APEX_HYPIHUB_TOKEN')
  })
})
