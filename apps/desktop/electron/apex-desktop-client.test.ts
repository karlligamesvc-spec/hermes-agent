/**
 * hc-1201: which APEX Desktop asks (apex-desktop-client.ts). apex-nodes opens
 * the editor to a whole plan only for a Desktop that says it is 0.17.77 or
 * later on mac-arm64, so every request that asks about the editor must say
 * it, the same way: main's tools check, the platform-skills sync, and the
 * engine's own tools check, which reads the environment main writes.
 *
 * Run with: npx vitest run electron/apex-desktop-client.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

import {
  DESKTOP_PLATFORM_ENV,
  DESKTOP_PLATFORM_HEADER,
  DESKTOP_VERSION_ENV,
  DESKTOP_VERSION_HEADER,
  desktopClient,
  desktopClientEnv,
  desktopClientHeaders,
  desktopPlatform
} from './apex-desktop-client'

const REPO = join(__dirname, '..', '..', '..')

describe('which Desktop asks', () => {
  test.each<[string, string, string]>([
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac-x64'],
    ['win32', 'x64', 'win-x64'],
    ['win32', 'arm64', 'win32-arm64'],
    ['linux', 'x64', 'linux-x64']
  ])('%s/%s is %s', (platform, arch, expected) => {
    assert.equal(desktopPlatform(platform, arch), expected)
  })

  test('the app’s own version and the platform it runs as', () => {
    assert.deepEqual(desktopClient({ getVersion: () => ' 0.17.77 ' }, 'darwin', 'arm64'), {
      version: '0.17.77',
      platform: 'mac-arm64'
    })
  })

  test('the environment the engine inherits, and the headers read back from it', () => {
    const env = desktopClientEnv({ version: '0.17.77', platform: 'mac-arm64' })

    assert.deepEqual(env, { APEX_DESKTOP_VERSION: '0.17.77', APEX_DESKTOP_PLATFORM: 'mac-arm64' })
    assert.deepEqual(desktopClientHeaders(env), {
      'X-Apex-Desktop-Version': '0.17.77',
      'X-Apex-Desktop-Platform': 'mac-arm64'
    })
  })

  test.each<[string, Record<string, string | undefined>, Record<string, string>]>([
    ['an environment that says nothing: what an older Desktop sends', {}, {}],
    ['blank values are no values', { [DESKTOP_VERSION_ENV]: ' ', [DESKTOP_PLATFORM_ENV]: '' }, {}],
    ['only what is there', { [DESKTOP_VERSION_ENV]: '0.17.77' }, { [DESKTOP_VERSION_HEADER]: '0.17.77' }]
  ])('%s', (_label, env, expected) => {
    assert.deepEqual(desktopClientHeaders(env), expected)
  })

  test('an empty version is left out of the engine’s environment', () => {
    assert.deepEqual(desktopClientEnv({ version: '', platform: 'mac-arm64' }), { [DESKTOP_PLATFORM_ENV]: 'mac-arm64' })
  })
})

describe('every sender says it the same way (rule 12: count the exits)', () => {
  test('main’s tools check for the editor sends the headers from main’s environment', () => {
    const source = readFileSync(join(__dirname, 'openfilm-studio.ts'), 'utf8')

    assert.match(source, /readOpenfilmAccess\(\{ apiBase, key \}, fetchImpl, desktopClientHeaders\(deps\.env\)\)/)
    assert.match(source, /headers: \{ \.\.\.client, authorization: `Bearer \$\{account\.key\}` \}/)
  })

  test('the platform-skills sync sends them, and main’s transport sets the headers it is given', () => {
    const sync = readFileSync(join(__dirname, 'apex-platform-skills-sync.ts'), 'utf8')
    const skills = readFileSync(join(__dirname, 'apex-platform-skills.ts'), 'utf8')
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    const transport = main.slice(main.indexOf('function apexAuthBodylessJson('), main.indexOf('function apexAuthGetJson('))

    assert.match(sync, /headers: desktopClientHeaders\(env\),/)
    assert.match(skills, /fetchJson\(url, \{ bearer: token, headers, timeoutMs \}\)/)
    assert.match(transport, /\{ bearer, headers = \{\}, timeoutMs = 12_000 \}/)
    // Set before Authorization, so a caller's header can never replace the bearer.
    assert.ok(
      transport.indexOf("Object.entries({ Accept: 'application/json', ...headers })") <
        transport.indexOf("request.setHeader('Authorization'")
    )
  })

  test('the engine’s check reads the variables main writes and sends the same headers', () => {
    const engine = readFileSync(join(REPO, 'apex_overlay', 'film_project.py'), 'utf8')

    assert.ok(engine.includes(`('${DESKTOP_VERSION_ENV}', '${DESKTOP_VERSION_HEADER}')`))
    assert.ok(engine.includes(`('${DESKTOP_PLATFORM_ENV}', '${DESKTOP_PLATFORM_HEADER}')`))
  })

  test('main writes them into its own environment as the editor registers, before any engine starts', () => {
    const source = readFileSync(join(__dirname, 'openfilm-studio.ts'), 'utf8')
    const register = source.slice(source.indexOf('export function registerOpenfilmStudio('))

    assert.match(register, /Object\.assign\(env, openfilmAgentEnv\(studio\.plan\), client\)/)
    assert.match(register, /desktopClientEnv\(desktopClient\(app as \{ getVersion: \(\) => string \}\)\)/)
  })
})
