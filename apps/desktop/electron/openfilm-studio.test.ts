/**
 * OpenFilm Studio in the preview pane (openfilm-studio.ts). The switch, where
 * the toolkit is found, its background install, the child's environment, and
 * the host protocol, run for real against a fake `openfilm` toolkit (a
 * `startStudio` that serves `/api/open`), so no OpenFilm download is needed.
 *
 * Run with: npx vitest run electron/openfilm-studio.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  type ApexAccount,
  createOpenfilmStudio,
  findOpenfilmToolkit,
  OPENFILM_FFMPEG_DIR_ENV,
  OPENFILM_TOOLKIT_ENV,
  openfilmAgentEnv,
  planOpenfilmStudio,
  readAdvertisedStudio,
  readOpenfilmAccess,
  redactStudioKey,
  registerOpenfilmStudio,
  studioChildEnv,
  type StudioProcesses,
  systemStudioProcesses
} from './openfilm-studio'

/**
 * A stand-in for `openfilm/studio`: what the host imports and calls. It notes
 * what it was given in `<data>/marks.jsonl` (the child gets no variable of the
 * test's own), and the first one started ends itself when `<data>/crash` exists.
 */
const FAKE_SERVER = `
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const data = join(process.env.OPENFILM_HOME, '..')
const marks = join(data, 'marks.jsonl')
const note = mark => appendFileSync(marks, JSON.stringify(mark) + '\\n')
export async function startStudio(options) {
  const first = !existsSync(marks)
  note({ started: { ...options, openBrowser: typeof options.openBrowser }, execArgv: process.execArgv, env: {
    home: process.env.OPENFILM_HOME, noBrowser: process.env.OPENFILM_NO_BROWSER, noUpdate: process.env.OPENFILM_NO_UPDATE_CHECK,
    chromium: process.env.OPENFILM_CHROMIUM ?? null, playwrightBrowsers: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
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
  const runFile = join(process.env.OPENFILM_HOME, 'run.json')
  if (options.advertise) {
    mkdirSync(process.env.OPENFILM_HOME, { recursive: true })
    writeFileSync(runFile, JSON.stringify({ pid: process.pid, origin, filmOrigin: 'http://localhost:1', key }))
  }
  options.openBrowser(origin + '/open?key=' + key + '&to=%2F')
  if (first && existsSync(join(data, 'crash'))) setTimeout(() => process.exit(3), 100)
  return { origin, filmOrigin: 'http://localhost:1', port: server.address().port, key, close: async () => {
    rmSync(runFile, { force: true })
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
    [OPENFILM_TOOLKIT_ENV]: fakeToolkit()
  }
}

/** The signed-in account as main holds it. */
const ACCOUNT = { apiBase: 'https://scheduler.test/', key: 'apex-key-for-test' }

/**
 * The Scheduler's tools check, as Desktop asks it: `open` is its answer for this
 * account (`unreadable` throws, as an unreachable network does). Every other
 * address (Studio's own) is fetched for real. `asked` notes each check.
 */
function scheduler(open: 'unreadable' | boolean, asked: Array<{ auth: string; url: string }> = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (!url.startsWith('https://scheduler.test') && /^https?:\/\/127\.0\.0\.1:/.test(url)) {
      return fetch(input, init)
    }

    asked.push({ url, auth: String(new Headers(init?.headers).get('authorization')) })

    if (open === 'unreadable') {
      throw new Error('offline')
    }

    return new Response(JSON.stringify({ ok: true, openfilm: { enabled: open } }), { status: 200 })
  }) as typeof fetch
}

/** What every test that runs Studio adds to createOpenfilmStudio: an account the Scheduler opens the editor to. */
const opened = () => ({ account: () => ACCOUNT, fetchImpl: scheduler(true) })

/** The toolkit as the engine installs it: its folder under tool-cache, the agent browser, and ready.json naming both. */
function installToolkit(): { chromium: string; toolkit: string } {
  const toolkit = fakeToolkit()
  const chromium = join(root, 'tool-cache', 'chrome', 'abc', 'chrome')
  mkdirSync(join(chromium, '..'), { recursive: true })
  writeFileSync(chromium, '')
  mkdirSync(join(root, 'tool-cache', 'openfilm'), { recursive: true })
  writeFileSync(join(root, 'tool-cache', 'openfilm', 'ready.json'), JSON.stringify({ schema: 1, toolkit, chromium }))

  return { chromium, toolkit }
}

const onPlan = (env: Record<string, string | undefined>) => planOpenfilmStudio(env, root)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openfilm-studio-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the account', () => {
  test('its data and the toolkit the engine installs are inside APEX’s data folder', () => {
    assert.deepEqual(planOpenfilmStudio({}, '/apex'), {
      dataRoot: join('/apex', 'openfilm'),
      ready: join('/apex', 'tool-cache', 'openfilm', 'ready.json'),
      devToolkit: null
    })
  })

  test.each<[string, () => ApexAccount | null, 'unreadable' | boolean, number]>([
    ['signed out (nothing is asked)', () => null, true, 0],
    ['signed in with no key (nothing is asked)', () => ({ apiBase: ACCOUNT.apiBase, key: ' ' }), true, 0],
    ['not opened to this account', () => ACCOUNT, false, 1],
    ['an answer that cannot be read, with none before', () => ACCOUNT, 'unreadable', 1]
  ])(
    '%s: Studio is never started and nothing is installed, whatever is installed',
    async (_label, account, says, asks) => {
      installToolkit()
      const spawn = vi.fn()
      const enginePython = vi.fn()
      const asked: Array<{ auth: string; url: string }> = []

      const studio = createOpenfilmStudio({
        env: onEnv(),
        hermesHome: root,
        execPath: process.execPath,
        basePath: () => '',
        enginePython,
        spawn: spawn as never,
        account,
        fetchImpl: scheduler(says, asked)
      })

      assert.deepEqual(await studio.status(), { on: false, ready: false, preparing: false })
      assert.deepEqual(await studio.open(filmProject('cook')), {
        ok: false,
        code: 'off',
        message: 'the editor is not open to this account'
      })
      assert.equal(await studio.prefetch(), 'off')
      expect(spawn).not.toHaveBeenCalled()
      expect(enginePython).not.toHaveBeenCalled()
      // Asked once at most (the answer is kept), and never without an account to ask for.
      assert.equal(asked.length, asks)
    }
  )

  test('asked with the account’s key, kept a minute, asked afresh for another account', async () => {
    const asked: Array<{ auth: string; url: string }> = []
    const clock = { now: 1_000 }
    let account = ACCOUNT
    const lines: string[] = []

    const studio = createOpenfilmStudio({
      env: onEnv(),
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => '',
      account: () => account,
      fetchImpl: scheduler(true, asked),
      now: () => clock.now,
      log: line => lines.push(line)
    })

    assert.equal((await studio.status()).on, true)
    assert.equal((await studio.status()).on, true)
    assert.deepEqual(asked, [{ url: 'https://scheduler.test/tools/v1/check', auth: 'Bearer apex-key-for-test' }])
    clock.now += 61_000
    await studio.status()
    assert.equal(asked.length, 2)
    account = { ...ACCOUNT, key: 'someone-else' }
    await studio.status()
    assert.deepEqual(asked[2], { url: 'https://scheduler.test/tools/v1/check', auth: 'Bearer someone-else' })
    // Each change is logged once, never the key.
    assert.deepEqual(lines, [
      '[openfilm-studio] the editor is open to this account',
      '[openfilm-studio] the editor is open to this account'
    ])
  })

  test('an answer that cannot be read keeps this account’s last one; a no a minute later closes it', async () => {
    const clock = { now: 1_000 }
    let says: 'unreadable' | boolean = true

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      scheduler(says)(input, init)) as typeof fetch

    const studio = createOpenfilmStudio({
      env: onEnv(),
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => '',
      account: () => ACCOUNT,
      fetchImpl,
      now: () => clock.now
    })

    assert.equal((await studio.status()).on, true)
    says = 'unreadable'
    clock.now += 61_000
    assert.equal((await studio.status()).on, true, 'a network blip took the editor away')
    says = false
    clock.now += 61_000
    assert.equal((await studio.status()).on, false)
  })

  test.each([
    ['yes', { ok: true, openfilm: { enabled: true } }, 200, true],
    ['no', { ok: true, openfilm: { enabled: false } }, 200, false],
    ['a Scheduler without the field', { ok: true, chatcut: { enabled: true } }, 200, false],
    ['not a boolean', { ok: true, openfilm: { enabled: 'true' } }, 200, false],
    ['a 401', { error: 'unauthorized' }, 401, null],
    ['a 503', {}, 503, null]
  ])('reading the answer: %s', async (_label, body, status, expected) => {
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

    assert.equal(await readOpenfilmAccess({ apiBase: 'https://s', key: 'k' }, fetchImpl), expected)
  })
})

describe('finding the toolkit', () => {
  test('the one the engine installed, as ready.json names it, with the agent browser', () => {
    const { chromium, toolkit } = installToolkit()

    assert.deepEqual(findOpenfilmToolkit(onPlan({})), {
      toolkit,
      serverModule: join(toolkit, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs'),
      browsers: null,
      chromium
    })
  })

  test.each([
    ['no ready.json', () => undefined],
    ['ready.json that does not read', () => writeFileSync(join(root, 'tool-cache', 'openfilm', 'ready.json'), '{')],
    ['a toolkit folder that is gone', () => rmSync(join(root, 'toolkit'), { recursive: true })],
    ['a browser that is gone', () => rmSync(join(root, 'tool-cache', 'chrome'), { recursive: true })],
    [
      'relative paths',
      () =>
        writeFileSync(
          join(root, 'tool-cache', 'openfilm', 'ready.json'),
          JSON.stringify({ toolkit: 'toolkit', chromium: 'chrome' })
        )
    ]
  ])('none with %s', (label, spoil) => {
    if (label === 'no ready.json') {
      mkdirSync(join(root, 'tool-cache', 'openfilm'), { recursive: true })
    } else {
      installToolkit()
      spoil()
    }

    assert.equal(findOpenfilmToolkit(onPlan({})), null)
  })

  test.each([
    ['a relative folder', 'toolkit'],
    ['a folder without openfilm', '/nowhere/toolkit']
  ])('a development toolkit: none with %s', (_label, toolkit) => {
    assert.equal(findOpenfilmToolkit(onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit })), null)
  })

  test('a development toolkit, with its own Playwright browsers', () => {
    const toolkit = fakeToolkit()

    expect(findOpenfilmToolkit(onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit }))).toEqual({
      toolkit,
      serverModule: join(toolkit, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs'),
      browsers: join(toolkit, 'browsers'),
      chromium: null
    })
  })
})

describe("the child's environment", () => {
  const MAIN_ENV = {
    HOME: '/Users/me',
    LANG: 'zh_CN.UTF-8',
    APEX_RELAY_KEY: 'sk-secret',
    OPENAI_API_KEY: 'sk-other',
    HERMES_HOME: '/apex',
    [OPENFILM_FFMPEG_DIR_ENV]: '/engine/.runtime/bin'
  }

  test('Studio folders under APEX data, the agent browser, no update check, the engine’s ffmpeg first, nothing else of main’s', () => {
    const plan = onPlan({})
    const { chromium, toolkit } = installToolkit()
    const found = findOpenfilmToolkit(plan)

    if (!found) {
      throw new Error('no toolkit')
    }

    const env = studioChildEnv(plan, found, MAIN_ENV, ['/apex/hermes-agent/.runtime/bin', '/usr/bin'].join(delimiter))

    expect(env).toMatchObject({
      HOME: '/Users/me',
      LANG: 'zh_CN.UTF-8',
      OPENFILM_HOME: join(root, 'openfilm', 'home'),
      OPENFILM_LIBRARY: join(root, 'openfilm', 'projects'),
      OPENFILM_SAVED: join(root, 'openfilm', 'saved'),
      OPENFILM_SKILLS: join(root, 'openfilm', 'skills'),
      OPENFILM_EXPORTS: join(root, 'openfilm', 'exports'),
      OPENFILM_NO_BROWSER: '1',
      OPENFILM_NO_UPDATE_CHECK: '1',
      OPENFILM_CHROMIUM: chromium,
      ELECTRON_RUN_AS_NODE: '1'
    })
    assert.equal('PLAYWRIGHT_BROWSERS_PATH' in env, false)
    assert.deepEqual(env.PATH.split(delimiter), [
      '/engine/.runtime/bin',
      join(toolkit, 'node_modules', '.bin'),
      '/apex/hermes-agent/.runtime/bin',
      '/usr/bin'
    ])

    for (const name of ['APEX_RELAY_KEY', 'OPENAI_API_KEY', 'HERMES_HOME', 'TOOLS_GATEWAY_KEY', OPENFILM_TOOLKIT_ENV]) {
      assert.equal(name in env, false, name)
    }
  })

  test('a development toolkit draws in its own Playwright browsers', () => {
    const toolkit = fakeToolkit()
    const plan = onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit })
    const found = findOpenfilmToolkit(plan)

    if (!found) {
      throw new Error('no toolkit')
    }

    const env = studioChildEnv(plan, found, MAIN_ENV, '/usr/bin')

    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(toolkit, 'browsers'))
    assert.equal('OPENFILM_CHROMIUM' in env, false)
  })

  test('the launch key never reaches a log line', () => {
    assert.equal(
      redactStudioKey('open http://127.0.0.1:5/open?key=abc123&to=%2F and /p?x=1&key=def'),
      'open http://127.0.0.1:5/open?key=…&to=%2F and /p?x=1&key=…'
    )
  })
})

describe('Studio in a child process', () => {
  function runStudio({ crash = false, env = onEnv() } = {}) {
    if (crash) {
      mkdirSync(join(root, 'openfilm'), { recursive: true })
      writeFileSync(join(root, 'openfilm', 'crash'), '')
    }

    const lines: string[] = []

    const studio = createOpenfilmStudio({
      env: { ...env, APEX_SECRET_FOR_TEST: 'must-not-pass' },
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => process.env.PATH ?? '',
      log: line => lines.push(line),
      readyTimeoutMs: 20_000,
      ...opened()
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

  test('the toolkit the engine installed runs Studio in the agent browser', async () => {
    const { chromium } = installToolkit()

    const { studio } = runStudio({
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
    })

    assert.deepEqual(await studio.status(), { on: true, ready: true, preparing: false })
    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    expect(marks().find(mark => mark.started)?.env).toMatchObject({ chromium, playwrightBrowsers: null })
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

describe('installing the toolkit in the background', () => {
  /** A stand-in for the engine's `python -m apex_overlay.media_tools openfilm`: it ends when the test says. */
  function fakeEngine() {
    const runs: Array<{ args: string[]; finish: (code: number, install?: boolean) => void }> = []

    const spawn = vi.fn((command: string, args: string[], options: any) => {
      if (command !== 'engine-python') {
        return nodeSpawn(command, args, options)
      }

      const proc: any = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.stdout.setEncoding = () => proc.stdout
      proc.stderr.setEncoding = () => proc.stderr
      proc.kill = vi.fn()
      runs.push({
        args,
        finish: (code, install = code === 0) => {
          if (install) {
            installToolkit()
          } else {
            proc.stderr.emit('data', 'APEX OpenFilm toolkit unavailable: URLError: offline\n')
          }

          proc.emit('exit', code, null)
        }
      })

      return proc
    })

    return { runs, spawn }
  }

  function studioWith(engine: ReturnType<typeof fakeEngine>, clock = { now: 1_000 }) {
    const enginePython = vi.fn(async () => ({ command: 'engine-python', cwd: '/engine', env: { ENGINE_ONLY: '1' } }))

    const studio = createOpenfilmStudio({
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      ...opened(),
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => process.env.PATH ?? '',
      enginePython,
      spawn: engine.spawn as never,
      now: () => clock.now,
      readyTimeoutMs: 20_000
    })

    return { clock, enginePython, studio }
  }

  test('a film opened before the toolkit is there: not ready, and the engine installs it, once', async () => {
    const engine = fakeEngine()
    const { enginePython, studio } = studioWith(engine)

    const opened = await studio.open(filmProject('cook'))

    assert.equal(opened.ok, false)
    assert.equal(opened.ok ? '' : opened.code, 'not_ready')
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    assert.deepEqual(engine.runs[0].args, ['-m', 'apex_overlay.media_tools', 'openfilm'])
    expect(engine.spawn.mock.calls[0][2]).toMatchObject({
      cwd: '/engine',
      env: { HOME: process.env.HOME, HERMES_HOME: root, ENGINE_ONLY: '1' }
    })
    assert.deepEqual(await studio.status(), { on: true, ready: false, preparing: true })

    // More video tools meanwhile start nothing more.
    assert.equal(await studio.prefetch(), 'preparing')
    assert.equal((await studio.open(filmProject('cook'))).ok, false)
    assert.equal(engine.runs.length, 1)
    assert.equal(enginePython.mock.calls.length, 1)

    engine.runs[0].finish(0)
    await vi.waitFor(async () => assert.deepEqual(await studio.status(), { on: true, ready: true, preparing: false }))
    assert.equal(await studio.prefetch(), 'ready')
    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    studio.stop()
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test('a failed install is tried again on a later trigger, not at once and without asking', async () => {
    const engine = fakeEngine()
    const { clock, studio } = studioWith(engine)

    assert.equal(await studio.prefetch(), 'started')
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    engine.runs[0].finish(1)
    await vi.waitFor(async () => assert.equal((await studio.status()).preparing, false))

    assert.equal((await studio.status()).ready, false)
    assert.equal(await studio.prefetch(), 'waiting')
    clock.now += 9 * 60_000
    assert.equal(await studio.prefetch(), 'waiting')
    clock.now += 2 * 60_000
    assert.equal(await studio.prefetch(), 'started')
    await vi.waitFor(() => assert.equal(engine.runs.length, 2))
  })

  test('an install that ends well but names no toolkit counts as failed', async () => {
    const engine = fakeEngine()
    const { studio } = studioWith(engine)

    await studio.prefetch()
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    engine.runs[0].finish(0, false)
    await vi.waitFor(async () => assert.equal((await studio.status()).preparing, false))
    assert.equal((await studio.status()).ready, false)
    assert.equal(await studio.prefetch(), 'waiting')
  })

  test('no engine yet: nothing runs, and it counts as a failed try', async () => {
    const engine = fakeEngine()
    const { enginePython, studio } = studioWith(engine)
    enginePython.mockResolvedValueOnce(null as never)

    await studio.prefetch()
    await vi.waitFor(async () => assert.equal((await studio.status()).preparing, false))
    assert.equal(engine.runs.length, 0)
    assert.equal(await studio.prefetch(), 'waiting')
  })
})

/**
 * A stand-in for a Studio the openfilm CLI started: a supervisor and a worker,
 * each running a file named as OpenFilm's (`openfilm/studio/server/main.mjs`),
 * the worker advertising in APEX's OPENFILM_HOME as Studio does. The worker
 * answers `/api/quit` (and goes) unless `deaf`; `stubborn` ignores SIGTERM.
 */
const CLI_STUDIO = `
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.OPENFILM_HOME
if (process.env.WORKER !== '1') {
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, WORKER: '1', SUPERVISOR: String(process.pid) }, stdio: 'ignore' })
  process.on('SIGTERM', () => { worker.kill('SIGTERM'); process.exit(0) })
  worker.on('exit', () => process.exit(0))
  setInterval(() => {}, 1000)
} else {
  const gone = () => { rmSync(join(home, 'run.json'), { force: true }); process.exit(0) }
  process.on('SIGTERM', () => { if (process.env.STUBBORN !== '1') gone() })
  const server = createServer((req, res) => {
    if (req.url === '/api/quit' && req.headers['x-studio-key'] === 'their-key' && process.env.DEAF !== '1') { writeFileSync(join(home, '..', 'quit-asked'), ''); res.writeHead(200).end('{}'); setTimeout(gone, 50); return }
    if (process.env.DEAF !== '1') res.writeHead(401).end('{}')
  })
  server.listen(0, '127.0.0.1', () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'run.json'), JSON.stringify({ pid: process.pid, supervisor: Number(process.env.SUPERVISOR), origin: 'http://127.0.0.1:' + server.address().port, key: 'their-key' }))
  })
}
`

const started: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const pid of started.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
})

/** Starts the stand-in in APEX's OPENFILM_HOME and waits for its run.json: its worker and supervisor pids. */
async function cliStudio({ deaf = false, stubborn = false } = {}) {
  const file = join(root, 'cli', 'node_modules', 'openfilm', 'studio', 'server', 'main.mjs')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, CLI_STUDIO)
  const home = join(root, 'openfilm', 'home')

  const supervisor = nodeSpawn(process.execPath, [file], {
    env: { PATH: process.env.PATH, OPENFILM_HOME: home, DEAF: deaf ? '1' : '', STUBBORN: stubborn ? '1' : '' },
    detached: true,
    stdio: 'ignore'
  })

  supervisor.unref()
  await vi.waitFor(() => expect(existsSync(join(home, 'run.json'))).toBe(true), { timeout: 10_000 })
  const run = JSON.parse(readFileSync(join(home, 'run.json'), 'utf8'))
  started.push(run.pid, run.supervisor)

  return { pid: run.pid as number, supervisor: run.supervisor as number }
}

describe('a Studio Desktop did not start, in APEX’s folders', () => {
  function desktop(processes?: StudioProcesses) {
    const lines: string[] = []

    const studio = createOpenfilmStudio({
      env: onEnv(),
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => process.env.PATH ?? '',
      log: line => lines.push(line),
      readyTimeoutMs: 20_000,
      ...opened(),
      ...(processes ? { processes } : {})
    })

    return { lines, studio }
  }

  test.skipIf(process.platform === 'win32')(
    'one an agent’s openfilm started before any film was opened is asked to quit, and Desktop’s own starts once it is gone',
    async () => {
      const other = await cliStudio()
      const { lines, studio } = desktop()

      const opened = await studio.open(filmProject('cook'))

      assert.equal(opened.ok, true)
      assert.equal(alive(other.pid) || alive(other.supervisor), false, 'the other Studio is still running')
      assert.ok(existsSync(join(root, 'openfilm', 'quit-asked')), 'it was not asked to quit, with its key')
      assert.ok(lines.some(line => line.includes(`stopped another Studio in APEX's folders (pid ${other.pid})`)))
      // Desktop's own advertises now: an agent's openfilm finds it.
      assert.equal(JSON.parse(readFileSync(join(root, 'openfilm', 'home', 'run.json'), 'utf8')).key, 'k3y-for-test')
      studio.stop()
      await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
    },
    30_000
  )

  test.skipIf(process.platform === 'win32')(
    'one that does not answer is ended before Desktop starts its own',
    async () => {
      const other = await cliStudio({ deaf: true })
      const { studio } = desktop()

      assert.equal((await studio.open(filmProject('cook'))).ok, true)
      assert.equal(alive(other.pid) || alive(other.supervisor), false, 'the other Studio is still running')
      studio.stop()
      await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
    },
    30_000
  )

  test.skipIf(process.platform === 'win32')(
    'at APEX’s quit, one started while no film was ever opened ends too, even one that ignores the request to stop',
    async () => {
      const other = await cliStudio({ deaf: true, stubborn: true })
      const { lines, studio } = desktop()

      studio.stop()

      assert.ok(
        lines.some(line => line.includes(`ended another Studio in APEX's folders (pid ${other.pid}) as APEX quits`))
      )
      // The supervisor goes at once; the worker that ignores SIGTERM is ended hard a few seconds later.
      await vi.waitFor(() => assert.equal(alive(other.supervisor), false), { timeout: 3_000 })
      await vi.waitFor(() => assert.equal(alive(other.pid), false), { timeout: 15_000, interval: 250 })
    },
    30_000
  )

  /** Processes as Desktop sees them, all in memory: `pids` alive, `openfilm` the ones whose command line names it. */
  function fakeProcesses(pids: number[], openfilm = pids) {
    const living = new Set(pids)
    const ended: number[] = []

    const processes: StudioProcesses = {
      alive: pid => living.has(pid),
      isOpenfilm: pid => openfilm.includes(pid),
      end: pid => {
        ended.push(pid)
        living.delete(pid)
      }
    }

    return { ended, processes }
  }

  function advertise(said: Record<string, unknown>) {
    mkdirSync(join(root, 'openfilm', 'home'), { recursive: true })
    writeFileSync(join(root, 'openfilm', 'home', 'run.json'), JSON.stringify(said))
  }

  test('another app’s own Studio (it answers 423) is left to that app', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => res.writeHead(423).end('{}'))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as { port: number }
    advertise({ pid: 4242, origin: `http://127.0.0.1:${port}`, key: 'theirs' })
    const { ended, processes } = fakeProcesses([4242])
    const { lines, studio } = desktop(processes)

    try {
      assert.equal((await studio.open(filmProject('cook'))).ok, true)
      assert.deepEqual(ended, [])
      assert.ok(lines.some(line => line.includes("another app's Studio runs in APEX's folders (pid 4242)")))
    } finally {
      studio.stop()
      server.close()
    }

    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test('a pid run.json names that is now another program’s is never ended', async () => {
    advertise({ pid: 4242, supervisor: 4241, origin: 'http://127.0.0.1:9', key: 'stale' })
    const { ended, processes } = fakeProcesses([4241, 4242], [])
    const { studio } = desktop(processes)

    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    studio.stop()
    assert.deepEqual(ended, [])
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test('at quit, Desktop’s own Studio (run.json names it) stops through its pipe, not as another', async () => {
    const ended: number[] = []
    const { studio } = desktop({ alive, isOpenfilm: () => true, end: pid => ended.push(pid) })

    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    const own = JSON.parse(readFileSync(join(root, 'openfilm', 'home', 'run.json'), 'utf8')).pid
    assert.equal(alive(own), true)
    studio.stop()
    assert.deepEqual(ended, [])
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test('an account the editor is not open to (or none signed in): quitting still ends another Studio there', () => {
    advertise({ pid: 4242, origin: 'http://127.0.0.1:9', key: 'theirs' })
    const { ended, processes } = fakeProcesses([4242])

    const studio = createOpenfilmStudio({
      env: {},
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => '',
      processes
    })

    studio.stop()
    assert.deepEqual(ended, [4242])
  })

  test.each([
    [
      'a full run.json',
      { pid: 7, supervisor: 6, origin: 'http://x', key: 'k' },
      { pid: 7, supervisor: 6, origin: 'http://x', key: 'k' }
    ],
    [
      'no supervisor',
      { pid: 7, origin: 'http://x', key: 'k' },
      { pid: 7, supervisor: null, origin: 'http://x', key: 'k' }
    ],
    ['no key', { pid: 7, origin: 'http://x' }, null],
    ['no pid', { origin: 'http://x', key: 'k' }, null]
  ])('run.json read: %s', (_label, said, expected) => {
    advertise(said)
    expect(readAdvertisedStudio(join(root, 'openfilm', 'home'))).toEqual(expected)
  })
})

describe('what Desktop does to another Studio’s processes', () => {
  function recorder() {
    const runs: Array<[string, string[]]> = []
    const spawns: Array<[string, string[]]> = []

    const run = ((command: string, args: string[]) => {
      runs.push([command, args])

      return { stdout: '/usr/bin/node /x/node_modules/openfilm/studio/server/main.mjs\n' }
    }) as never

    const spawn = ((command: string, args: string[]) => {
      spawns.push([command, args])

      return { unref: () => undefined }
    }) as never

    return { run, runs, spawn, spawns }
  }

  test('on macOS and Linux: its command line from ps; SIGTERM, then ended hard a few seconds later', () => {
    const { run, runs, spawn, spawns } = recorder()
    const processes = systemStudioProcesses('darwin', run, spawn)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    let signals: unknown[][] = []

    try {
      assert.equal(processes.isOpenfilm(77), true)
      processes.end(77)
      signals = kill.mock.calls.map(call => [...call])
    } finally {
      kill.mockRestore()
    }

    assert.deepEqual(runs, [['ps', ['-o', 'command=', '-p', '77']]])
    assert.deepEqual(signals, [[77, 'SIGTERM']])
    assert.deepEqual(spawns, [['/bin/sh', ['-c', 'sleep 5; kill -9 77 2>/dev/null']]])
  })

  test('on Windows: its command line from CIM; the whole tree ended (a signal would end one process)', () => {
    const { run, runs, spawn, spawns } = recorder()
    const processes = systemStudioProcesses('win32', run, spawn)

    assert.equal(processes.isOpenfilm(77), true)
    processes.end(77)
    assert.equal(runs[0][0], 'powershell.exe')
    assert.match(runs[0][1].join(' '), /Get-CimInstance Win32_Process -Filter "ProcessId=77"\)\.CommandLine/)
    assert.deepEqual(runs[1], ['taskkill', ['/PID', '77', '/T', '/F']])
    assert.deepEqual(spawns, [])
  })

  test('a command line that does not name OpenFilm is not a Studio', () => {
    const processes = systemStudioProcesses('linux', (() => ({ stdout: '/usr/bin/vim notes.txt\n' })) as never)

    assert.equal(processes.isOpenfilm(77), false)
  })

  test('alive: this process is, a pid that ended is not', async () => {
    const processes = systemStudioProcesses()
    const ended = nodeSpawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise(done => ended.once('exit', done))

    assert.equal(processes.alive(process.pid), true)
    assert.equal(processes.alive(ended.pid ?? 0), false)
  })
})

describe('main’s wiring', () => {
  test('the window asks for the status, an address and an install; quitting stops Studio', async () => {
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
    const quit: Array<() => void> = []

    const studio = {
      open: vi.fn(),
      prefetch: vi.fn(() => 'started'),
      status: vi.fn(),
      stop: vi.fn(),
      plan: onPlan({})
    }

    const env: Record<string, string | undefined> = {}

    registerOpenfilmStudio(
      studio as never,
      { handle: (channel, listener) => handlers.set(channel, listener) },
      { on: (_event, listener) => quit.push(listener) },
      env
    )

    assert.deepEqual([...handlers.keys()].sort(), [
      'hermes:openfilmStudio:open',
      'hermes:openfilmStudio:prefetch',
      'hermes:openfilmStudio:status'
    ])
    handlers.get('hermes:openfilmStudio:open')?.({}, '/work/cook')
    expect(studio.open).toHaveBeenCalledWith('/work/cook')
    assert.equal(handlers.get('hermes:openfilmStudio:prefetch')?.({}), 'started')
    quit.forEach(listener => listener())
    expect(studio.stop).toHaveBeenCalledOnce()
  })

  test('main gives the module the signed-in account: its API base and the managed APEX key the engine’s tools use', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    const call = main.slice(main.indexOf('const openfilmStudio = createOpenfilmStudio({'))

    expect(call.slice(0, call.indexOf('\n})'))).toContain(
      'account: () => ({ apiBase: resolveApexEndpoints(process.env).apiBase, key: resolveManagedConfig().key }),'
    )
    // The same key the engine's tools get (desktopPlatformToolSpawnEnv), so Desktop and the engine read one answer.
    expect(main).toContain('buildPlatformToolSpawnEnv({ apiBase, currentEnv: process.env, key: managed.key })')
  })

  test('every engine started after it runs OpenFilm hosted, in Studio’s folders, opened to the account or not', () => {
    const plan = onPlan({})
    const env: Record<string, string | undefined> = { PATH: '/bin' }

    registerOpenfilmStudio(
      { open: vi.fn(), prefetch: vi.fn(), status: vi.fn(), stop: vi.fn(), plan } as never,
      { handle: () => undefined },
      { on: () => undefined },
      env
    )

    expect(env).toEqual({ PATH: '/bin', ...openfilmAgentEnv(plan) })
    expect(openfilmAgentEnv(plan)).toEqual({
      OPENFILM_HOME: join(root, 'openfilm', 'home'),
      OPENFILM_LIBRARY: join(root, 'openfilm', 'projects'),
      OPENFILM_SAVED: join(root, 'openfilm', 'saved'),
      OPENFILM_SKILLS: join(root, 'openfilm', 'skills'),
      OPENFILM_EXPORTS: join(root, 'openfilm', 'exports'),
      OPENFILM_HOSTED: '1',
      OPENFILM_NO_BROWSER: '1',
      OPENFILM_NO_UPDATE_CHECK: '1'
    })
  })
})
