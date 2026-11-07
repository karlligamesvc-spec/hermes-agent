/**
 * PROTOTYPE: OpenFilm Studio in the preview pane (openfilm-studio.ts). The
 * switch, the child's environment, and the host protocol, run for real against
 * a fake `openfilm` toolkit (a `startStudio` that serves `/api/open`), so no
 * OpenFilm download is needed.
 *
 * Run with: npx vitest run electron/openfilm-studio.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createOpenfilmStudio,
  OPENFILM_FFMPEG_DIR_ENV,
  OPENFILM_STUDIO_ENV,
  OPENFILM_TOOLKIT_ENV,
  planOpenfilmStudio,
  redactStudioKey,
  studioChildEnv
} from './openfilm-studio'

/**
 * A stand-in for `openfilm/studio`: what the host imports and calls. It notes
 * what it was given in `<data>/marks.jsonl` (the child gets no variable of the
 * test's own), and the first one started ends itself when `<data>/crash` exists.
 */
const FAKE_SERVER = `
import { createServer } from 'node:http'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const data = join(process.env.OPENFILM_HOME, '..')
const marks = join(data, 'marks.jsonl')
const note = mark => appendFileSync(marks, JSON.stringify(mark) + '\\n')
export async function startStudio(options) {
  const first = !existsSync(marks)
  note({ started: { ...options, openBrowser: typeof options.openBrowser }, execArgv: process.execArgv, env: {
    home: process.env.OPENFILM_HOME, noBrowser: process.env.OPENFILM_NO_BROWSER, noUpdate: process.env.OPENFILM_NO_UPDATE_CHECK,
    secret: process.env.APEX_SECRET_FOR_TEST ?? null } })
  const key = 'k3y-for-test'
  let origin = ''
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.url !== '/api/open' || req.headers['x-studio-key'] !== key) { res.writeHead(401).end('{}'); return }
      const { path, fallback } = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: origin + '/open?key=' + key + '&to=' + encodeURIComponent('/projects/' + path.split(/[\\\\/]/).pop()) + '&fallback=' + fallback }))
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = 'http://127.0.0.1:' + server.address().port
  options.openBrowser(origin + '/open?key=' + key + '&to=%2F')
  if (first && existsSync(join(data, 'crash'))) setTimeout(() => process.exit(3), 100)
  return { origin, filmOrigin: 'http://localhost:1', port: server.address().port, key, close: async () => {
    note({ closed: true })
    await new Promise(done => server.close(done))
  } }
}
`

let root = ''

function fakeToolkit(): string {
  const toolkit = join(root, 'toolkit')
  const server = join(toolkit, 'node_modules', 'openfilm', 'studio', 'server')
  mkdirSync(server, { recursive: true })
  mkdirSync(join(toolkit, 'browsers'), { recursive: true })
  writeFileSync(join(server, 'server.mjs'), FAKE_SERVER)

  return toolkit
}

function filmProject(name: string): string {
  const folder = join(root, 'work', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'film.html'), '<film></film>')

  return folder
}

function marks(): Array<Record<string, any>> {
  const file = join(root, 'openfilm', 'marks.jsonl')

  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []
}

function onEnv(): Record<string, string | undefined> {
  return {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    [OPENFILM_STUDIO_ENV]: '1',
    [OPENFILM_TOOLKIT_ENV]: fakeToolkit()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openfilm-studio-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the switch', () => {
  test.each([
    ['unset', undefined],
    ['0', '0'],
    ['off', 'off'],
    ['an unknown word', 'maybe']
  ])('%s keeps it off, whatever else is set', (_label, value) => {
    const env = { [OPENFILM_STUDIO_ENV]: value, [OPENFILM_TOOLKIT_ENV]: fakeToolkit() }

    assert.deepEqual(planOpenfilmStudio(env, '/apex'), { on: false, reason: 'switch_off' })
  })

  test.each([
    ['no toolkit named', undefined],
    ['a relative toolkit', 'toolkit'],
    ['a toolkit without openfilm', '/nowhere/toolkit']
  ])('on with %s stays off', (_label, toolkit) => {
    assert.deepEqual(planOpenfilmStudio({ [OPENFILM_STUDIO_ENV]: '1', [OPENFILM_TOOLKIT_ENV]: toolkit }, '/apex'), {
      on: false,
      reason: 'no_toolkit'
    })
  })

  test('on with a toolkit runs it, with its data inside APEX’s data folder', () => {
    const toolkit = fakeToolkit()

    assert.deepEqual(planOpenfilmStudio({ [OPENFILM_STUDIO_ENV]: '1', [OPENFILM_TOOLKIT_ENV]: toolkit }, '/apex'), {
      on: true,
      toolkit,
      serverModule: join(toolkit, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs'),
      browsers: join(toolkit, 'browsers'),
      dataRoot: join('/apex', 'openfilm')
    })
  })

  test('off, Studio is never started and nothing is logged', async () => {
    const spawn = vi.fn()
    const lines: string[] = []

    const studio = createOpenfilmStudio({
      env: {},
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => '',
      spawn: spawn as never,
      log: line => lines.push(line)
    })

    assert.deepEqual(studio.status(), { on: false })
    assert.equal((await studio.open(filmProject('cook'))).ok, false)
    expect(spawn).not.toHaveBeenCalled()
    assert.deepEqual(lines, [])
  })
})

describe("the child's environment", () => {
  test('Studio folders under APEX data, no browser, no update check, the engine’s ffmpeg first, nothing else of main’s', () => {
    const plan = planOpenfilmStudio(onEnv(), '/apex')

    if (plan.on !== true) {
      throw new Error(`expected the prototype on, got ${JSON.stringify(plan)}`)
    }

    const env = studioChildEnv(
      plan,
      {
        HOME: '/Users/me',
        LANG: 'zh_CN.UTF-8',
        APEX_RELAY_KEY: 'sk-secret',
        OPENAI_API_KEY: 'sk-other',
        HERMES_HOME: '/apex',
        [OPENFILM_FFMPEG_DIR_ENV]: '/engine/.runtime/bin'
      },
      ['/apex/hermes-agent/.runtime/bin', '/usr/bin'].join(delimiter)
    )

    expect(env).toMatchObject({
      HOME: '/Users/me',
      LANG: 'zh_CN.UTF-8',
      OPENFILM_HOME: join('/apex', 'openfilm', 'home'),
      OPENFILM_LIBRARY: join('/apex', 'openfilm', 'projects'),
      OPENFILM_SAVED: join('/apex', 'openfilm', 'saved'),
      OPENFILM_SKILLS: join('/apex', 'openfilm', 'skills'),
      OPENFILM_EXPORTS: join('/apex', 'openfilm', 'exports'),
      OPENFILM_NO_BROWSER: '1',
      OPENFILM_NO_UPDATE_CHECK: '1',
      PLAYWRIGHT_BROWSERS_PATH: plan.browsers,
      ELECTRON_RUN_AS_NODE: '1'
    })
    assert.deepEqual(env.PATH.split(delimiter), [
      '/engine/.runtime/bin',
      join(plan.toolkit, 'node_modules', '.bin'),
      '/apex/hermes-agent/.runtime/bin',
      '/usr/bin'
    ])

    for (const name of ['APEX_RELAY_KEY', 'OPENAI_API_KEY', 'HERMES_HOME', OPENFILM_STUDIO_ENV, OPENFILM_TOOLKIT_ENV]) {
      assert.equal(name in env, false, name)
    }
  })

  test('the launch key never reaches a log line', () => {
    assert.equal(
      redactStudioKey('open http://127.0.0.1:5/open?key=abc123&to=%2F and /p?x=1&key=def'),
      'open http://127.0.0.1:5/open?key=…&to=%2F and /p?x=1&key=…'
    )
  })
})

describe('Studio in a child process', () => {
  function runStudio({ crash = false } = {}) {
    if (crash) {
      mkdirSync(join(root, 'openfilm'), { recursive: true })
      writeFileSync(join(root, 'openfilm', 'crash'), '')
    }

    const lines: string[] = []

    const studio = createOpenfilmStudio({
      env: { ...onEnv(), APEX_SECRET_FOR_TEST: 'must-not-pass' },
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => process.env.PATH ?? '',
      log: line => lines.push(line),
      readyTimeoutMs: 20_000
    })

    return { lines, studio }
  }

  test('opens a project, reuses one Studio, and stops it', async () => {
    const { lines, studio } = runStudio()
    const cook = filmProject('cook')

    const first = await studio.open(cook)
    const second = await studio.open(filmProject('trip'))

    assert.equal(first.ok, true)
    assert.match(
      first.ok ? first.url : '',
      /^http:\/\/127\.0\.0\.1:\d+\/open\?key=k3y-for-test&to=%2Fprojects%2Fcook&fallback=0$/
    )
    assert.match(second.ok ? second.url : '', /to=%2Fprojects%2Ftrip/)

    const started = marks().filter(mark => mark.started)
    assert.equal(started.length, 1)
    expect(started[0].started).toEqual({ port: 0, stays: true, advertise: true, openBrowser: 'function' })
    // A file host, not `-e`: Studio forks its workers with execArgv, which must not carry the host.
    assert.deepEqual(started[0].execArgv, [])
    expect(started[0].env).toMatchObject({
      home: join(root, 'openfilm', 'home'),
      noBrowser: '1',
      noUpdate: '1',
      secret: null
    })

    // Studio's own browser opening is reported, not done, and its key is not logged.
    await vi.waitFor(() => expect(lines.some(line => line.includes('asked to open'))).toBe(true))
    assert.equal(
      lines.some(line => line.includes('k3y-for-test')),
      false
    )

    studio.stop()
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test('a Studio that ended is started again by the next open', async () => {
    const { lines, studio } = runStudio({ crash: true })

    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    await vi.waitFor(() => expect(lines.some(line => line.includes('Studio ended (exit code 3)'))).toBe(true), {
      timeout: 10_000
    })

    const again = await studio.open(filmProject('cook'))

    assert.equal(again.ok, true)
    assert.equal(marks().filter(mark => mark.started).length, 2)
    studio.stop()
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test.each([
    ['a relative folder', 'work/cook'],
    ['a folder without film.html', '/'],
    ['not a string', 42]
  ])('refuses %s without starting Studio', async (_label, folder) => {
    const { studio } = runStudio()

    assert.equal((await studio.open(folder)).ok, false)
    assert.equal(marks().length, 0)
  })
})
