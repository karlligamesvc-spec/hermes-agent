/**
 * APEX-hosted Hypit generation: the launch switch main settles from
 * `desktop_features.hypihub_apex`, and the `hypit` wrapper that reads it.
 * The off path is pinned against fork main by hypit-hosted-identity.test.ts.
 *
 * Run with: npx vitest run electron/apex-hypihub.test.ts --project electron
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { hostedHypit, hypitEnvironment } from '../../../apex_overlay/hypit_environment.mjs'

import { applyHypihubApexSwitch, HYPIHUB_APEX_ACTIVE_ENV } from './apex-hypihub'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import { SINGLE_THREAD_ACTIVE_ENV } from './apex-single-thread'

const ON = { desktop_features: { hypihub_apex: true } }
const FAKE_KEY = 'fake-agent-key-not-a-secret'

describe('the launch switch', () => {
  test.each([
    [ON, true],
    [{ desktop_features: { hypihub_apex: 'true' } }, false],
    [{ desktop_features: { hypihub_apex: 1 } }, false],
    [{ desktop_features: { single_thread: true } }, false],
    [{ hypihub_apex: true }, false],
    [[], false],
    [null, false]
  ])('payload %j turns it on: %s', (payload, on) => {
    const env: Record<string, string | undefined> = {}

    expect(applyHypihubApexSwitch(env, payload)).toBe(on)
    expect(env[HYPIHUB_APEX_ACTIVE_ENV]).toBe(on ? '1' : undefined)
  })

  test('only the platform turns it on: no install variable, and a stale engine value is removed', () => {
    for (const name of ['APEXNODES_HYPIHUB_APEX', 'APEXNODES_HYPIHUB']) {
      const env: Record<string, string | undefined> = { [name]: '1', [HYPIHUB_APEX_ACTIVE_ENV]: '1' }

      expect(applyHypihubApexSwitch(env, null)).toBe(false)
      expect(env).toEqual({ [name]: '1' })
    }
  })

  test('is settled with the other launch switches and reported once', () => {
    const env: Record<string, string | undefined> = {}
    const lines: string[] = []
    const payload = { desktop_features: { hypihub_apex: true, single_thread: true } }

    expect(applyDesktopFeatureSwitches(env, payload, line => lines.push(line))).toEqual([
      SINGLE_THREAD_ACTIVE_ENV,
      HYPIHUB_APEX_ACTIVE_ENV
    ])
    expect(env[HYPIHUB_APEX_ACTIVE_ENV]).toBe('1')
    expect(lines.filter(line => line.includes(HYPIHUB_APEX_ACTIVE_ENV))).toEqual([
      '[client-config] APEX_HYPIHUB_ACTIVE=1 (desktop_features.hypihub_apex)'
    ])
  })
})

describe('the wrapper env', () => {
  test.each([
    ['1', true],
    ['0', false],
    ['true', false],
    ['', false],
    [undefined, false]
  ])('switch value %j is on: %s', (value, on) => {
    expect(hostedHypit(value === undefined ? {} : { APEX_HYPIHUB_ACTIVE: value })).toBe(on)
  })

  test('with the switch on, the env Store slot gets the platform-tool credential', () => {
    const env = hypitEnvironment(
      { APEX_HYPIHUB_ACTIVE: '1', PATH: '/usr/bin', TOOLS_GATEWAY_KEY: FAKE_KEY },
      '/runtime',
      '/runtime/node/bin/node',
      'https://cos/registry'
    )

    expect(env.APEX_HYPIHUB_TOKEN).toBe(FAKE_KEY)
  })

  test('with the switch on but signed out, no slot value is invented', () => {
    const env = hypitEnvironment({ APEX_HYPIHUB_ACTIVE: '1', PATH: '/usr/bin' }, '/runtime', '/node', 'https://r')

    expect(Object.keys(env)).not.toContain('APEX_HYPIHUB_TOKEN')
  })
})

// The real wrapper, spawned against a project-local fake Hypit (hypit_project.mjs
// prefers a project installation). The fake prints what Hypit itself received.
describe('the hypit wrapper command', () => {
  const wrapper = resolve(__dirname, '../../../apex_overlay/hypit_cli.mjs')
  let project = ''

  afterEach(() => {
    if (project) {
      rmSync(project, { force: true, recursive: true })
    }
  })

  function fakeProject() {
    project = mkdtempSync(join(tmpdir(), 'apex-hypit-hosted-'))
    const hypit = join(project, 'node_modules/@hypit/hypit')
    const koffi = join(project, 'node_modules/koffi')
    mkdirSync(join(hypit, 'bin'), { recursive: true })
    mkdirSync(koffi, { recursive: true })
    writeFileSync(join(hypit, 'package.json'), JSON.stringify({ name: '@hypit/hypit', version: '0.3.1' }))
    writeFileSync(
      join(hypit, 'bin/hypit.mjs'),
      'console.log(JSON.stringify({ args: process.argv.slice(2), token: process.env.APEX_HYPIHUB_TOKEN ?? null }))\n'
    )
    writeFileSync(join(koffi, 'package.json'), JSON.stringify({ name: 'koffi', main: 'index.js' }))
    writeFileSync(join(koffi, 'index.js'), '')
    writeFileSync(join(project, 'package.json'), JSON.stringify({ hypit: { project: true } }))

    return project
  }

  function run(args: string[], extra: Record<string, string>) {
    const env: Record<string, string | undefined> = { ...process.env, TOOLS_GATEWAY_KEY: FAKE_KEY, ...extra }

    if (!('APEX_HYPIHUB_ACTIVE' in extra)) {
      delete env.APEX_HYPIHUB_ACTIVE
    }

    return spawnSync(process.execPath, [wrapper, ...args], { cwd: fakeProject(), encoding: 'utf8', env })
  }

  test.each([
    ['unset', {}],
    ['zero', { APEX_HYPIHUB_ACTIVE: '0' }]
  ])('switch %s: apex-enable-hosted reaches Hypit unchanged and no slot value is set', (_name, extra) => {
    const result = run(['apex-enable-hosted'], extra)

    expect(JSON.parse(result.stdout)).toEqual({ args: ['apex-enable-hosted'], token: null })
  })

  test('switch on: Hypit commands carry the slot value, apex-enable-hosted goes to the APEX merge', () => {
    const forwarded = run(['version'], { APEX_HYPIHUB_ACTIVE: '1' })

    expect(JSON.parse(forwarded.stdout)).toEqual({ args: ['version'], token: FAKE_KEY })

    // The APEX merge runs in the runtime's Python. A checkout has no runtime venv (it fails to
    // start) or the fake project has no Profile (the merge refuses): either way Hypit never ran.
    const merged = run(['apex-enable-hosted'], { APEX_HYPIHUB_ACTIVE: '1' })

    expect(merged.stdout).toBe('')
    expect(merged.stderr).toMatch(/Hypit could not start: .*python|APEX hosted generation not added/)
    expect(merged.stderr).not.toContain(FAKE_KEY)
  })
})
