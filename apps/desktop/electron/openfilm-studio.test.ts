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
import { delimiter, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { desktopPlatform } from './apex-desktop-client'
import {
  APEX_EDITOR_DIR,
  type ApexAccount,
  createOpenfilmStudio,
  ENGINE_TOOLKIT_LOCK,
  findOpenfilmToolkit,
  INSTALL_PROGRESS_ENV,
  INSTALL_PROGRESS_MARK,
  installedOpenfilmToolkit,
  installOutput,
  LAST_PROJECT_FILE,
  OPENFILM_FFMPEG_DIR_ENV,
  OPENFILM_OFFLINE_URL,
  OPENFILM_TOOLKIT_ENV,
  openfilmAgentEnv,
  openfilmEngineRoot,
  parseInstallProgress,
  parseOpenfilmCheck,
  pinnedOpenfilmToolkit,
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
 * With `<data>/slow-close`, closing takes a moment (run.json goes last), as a
 * real Studio's does.
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
  const readIndex = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return 'unreadable' } }
  note({ started: { ...options, openBrowser: typeof options.openBrowser }, pid: process.pid, serverModule: process.env.APEX_OPENFILM_SERVER_MODULE, execArgv: process.execArgv, env: {
    home: process.env.OPENFILM_HOME, noBrowser: process.env.OPENFILM_NO_BROWSER, noUpdate: process.env.OPENFILM_NO_UPDATE_CHECK,
    chromium: process.env.OPENFILM_CHROMIUM ?? null, playwrightBrowsers: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
    secret: process.env.APEX_SECRET_FOR_TEST ?? null, libraryUrl: process.env.OPENFILM_LIBRARY_URL ?? null,
    apiUrl: process.env.OPENFILM_API_URL ?? null }, indexes: {
    examples: process.env.OPENFILM_EXAMPLES_INDEX ? readIndex(process.env.OPENFILM_EXAMPLES_INDEX) : null,
    skills: process.env.OPENFILM_SKILLS_INDEX ? readIndex(process.env.OPENFILM_SKILLS_INDEX) : null } })
  const key = 'k3y-for-test'
  let origin = ''
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.url !== '/api/open' || req.headers['x-studio-key'] !== key) { res.writeHead(401).end('{}'); return }
      const { path, fallback } = JSON.parse(body)
      note({ opened: path.split(/[\\\\/]/).pop(), pid: process.pid })
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
    if (existsSync(join(data, 'slow-close'))) await new Promise(done => setTimeout(done, 600))
    rmSync(runFile, { force: true })
    note({ closed: true, pid: process.pid })
    await new Promise(done => server.close(done))
  } }
}
`

let root = ''

function fakeToolkit(folder = 'toolkit'): string {
  const toolkit = join(root, folder)
  const server = join(toolkit, 'node_modules', 'openfilm', 'studio', 'server')
  mkdirSync(server, { recursive: true })
  mkdirSync(join(toolkit, 'browsers'), { recursive: true })
  writeFileSync(join(server, 'server.mjs'), FAKE_SERVER)

  return toolkit
}

/** APEX's build of the editor in `toolkit` (hc-1188): `index` false leaves the folder without its index.html. */
function addApexEditor(toolkit: string, index = true): string {
  const editor = join(toolkit, APEX_EDITOR_DIR)
  mkdirSync(join(editor, 'assets'), { recursive: true })

  if (index) {
    writeFileSync(join(editor, 'index.html'), '<!doctype html><title>APEX</title>')
  }

  return editor
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

/** The toolkit the engine pins (desktop-lock.json `openfilm.sha256`), and the one an earlier APEX pinned (hc-1199). */
const PIN = '5254c8a04a735240ab10ec0a23aedc524cc0b49c37ca0990052f14d8c8a95571'
const OLD_PIN = '9890ddff00000000000000000000000000000000000000000000000000000000'

/** An engine's root whose desktop-lock.json pins `sha256`, laid out as apex_overlay/media_tools.py reads it. */
function engineRoot(sha256: string = PIN, folder = 'engine'): string {
  const engine = join(root, folder)
  mkdirSync(join(engine, ...ENGINE_TOOLKIT_LOCK, '..'), { recursive: true })
  writeFileSync(
    join(engine, ...ENGINE_TOOLKIT_LOCK),
    JSON.stringify({ browser: {}, openfilm: { version: '0.3.0', patches: [], sha256 } })
  )

  return engine
}

/**
 * The toolkit as the engine installs it: its folder under tool-cache (named by
 * its sha256, as the engine names it), the agent browser, and ready.json naming
 * both, with the sha256 it was installed for.
 */
function installToolkit(sha256: string = PIN): { chromium: string; toolkit: string } {
  const toolkit = fakeToolkit(join('tool-cache', 'openfilm', sha256))
  const chromium = join(root, 'tool-cache', 'chrome', 'abc', 'chrome')
  mkdirSync(join(chromium, '..'), { recursive: true })
  writeFileSync(chromium, '')
  writeFileSync(
    join(root, 'tool-cache', 'openfilm', 'ready.json'),
    JSON.stringify({ schema: 1, version: '0.3.0', sha256, toolkit, chromium })
  )

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

    assert.deepEqual(findOpenfilmToolkit(onPlan({}), PIN), {
      toolkit,
      serverModule: join(toolkit, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs'),
      browsers: null,
      chromium,
      editor: null
    })
  })

  // hc-1188: a toolkit built with APEX's editor has Studio serve it; an older one, or a folder without its index.html, Studio's own.
  test.each([
    ['carries it', true, true],
    ['has the folder without its index.html', false, false]
  ])('APEX’s editor when the toolkit %s', (_label, index, found) => {
    const { toolkit } = installToolkit()
    const editor = addApexEditor(toolkit, index)
    const dev = fakeToolkit()
    const devEditor = addApexEditor(dev, index)

    expect(findOpenfilmToolkit(onPlan({}), PIN)?.editor).toBe(found ? editor : null)
    expect(findOpenfilmToolkit(onPlan({ [OPENFILM_TOOLKIT_ENV]: dev }), null)?.editor).toBe(found ? devEditor : null)
  })

  test.each([
    ['no ready.json', () => undefined],
    ['ready.json that does not read', () => writeFileSync(join(root, 'tool-cache', 'openfilm', 'ready.json'), '{')],
    ['a toolkit folder that is gone', () => rmSync(join(root, 'tool-cache', 'openfilm', PIN), { recursive: true })],
    ['a browser that is gone', () => rmSync(join(root, 'tool-cache', 'chrome'), { recursive: true })],
    [
      'relative paths',
      () =>
        writeFileSync(
          join(root, 'tool-cache', 'openfilm', 'ready.json'),
          JSON.stringify({ sha256: PIN, toolkit: 'toolkit', chromium: 'chrome' })
        )
    ]
  ])('none with %s', (label, spoil) => {
    if (label === 'no ready.json') {
      mkdirSync(join(root, 'tool-cache', 'openfilm'), { recursive: true })
    } else {
      installToolkit()
      spoil()
    }

    assert.equal(findOpenfilmToolkit(onPlan({}), PIN), null)
  })

  test.each([
    ['a relative folder', 'toolkit'],
    ['a folder without openfilm', '/nowhere/toolkit']
  ])('a development toolkit: none with %s', (_label, toolkit) => {
    assert.equal(findOpenfilmToolkit(onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit }), null), null)
  })

  // hc-1199: only the toolkit the engine pins counts; an update that moves the pin leaves the old ready.json behind.
  test.each<[string, null | string, null | string, boolean]>([
    ['the toolkit the engine pins', PIN, PIN, true],
    ['the toolkit an earlier APEX pinned (an update moved the pin)', PIN, OLD_PIN, false],
    ['no sha256', PIN, null, false],
    ['any toolkit, while the engine’s pin cannot be read', null, PIN, false]
  ])('ready.json naming %s', (_label, pinned, installed, found) => {
    installToolkit(installed ?? PIN)

    if (installed === null) {
      const ready = join(root, 'tool-cache', 'openfilm', 'ready.json')
      const { sha256: _gone, ...rest } = JSON.parse(readFileSync(ready, 'utf8'))
      writeFileSync(ready, JSON.stringify(rest))
    }

    assert.equal(findOpenfilmToolkit(onPlan({}), pinned) !== null, found)
    assert.equal(installedOpenfilmToolkit(onPlan({})), installed)
  })

  test('a development toolkit is the developer’s own: no pin applies to it', () => {
    const toolkit = fakeToolkit()

    assert.equal(findOpenfilmToolkit(onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit }), OLD_PIN)?.toolkit, toolkit)
  })

  test('a development toolkit, with its own Playwright browsers', () => {
    const toolkit = fakeToolkit()

    expect(findOpenfilmToolkit(onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit }), null)).toEqual({
      toolkit,
      serverModule: join(toolkit, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs'),
      browsers: join(toolkit, 'browsers'),
      chromium: null,
      editor: null
    })
  })
})

describe('the toolkit the engine pins (hc-1199)', () => {
  test('desktop-lock.json’s openfilm.sha256, under the engine’s root, with or without a BOM', () => {
    const engine = engineRoot(PIN)

    assert.equal(pinnedOpenfilmToolkit(engine), PIN)
    writeFileSync(
      join(engine, ...ENGINE_TOOLKIT_LOCK),
      `\uFEFF${readFileSync(join(engine, ...ENGINE_TOOLKIT_LOCK), 'utf8')}`
    )
    assert.equal(pinnedOpenfilmToolkit(engine), PIN)
  })

  test.each<[string, () => null | string]>([
    ['no engine', () => null],
    ['a relative root', () => 'engine'],
    ['no lock', () => root],
    [
      'a lock that does not read',
      () => {
        const engine = engineRoot()
        writeFileSync(join(engine, ...ENGINE_TOOLKIT_LOCK), '{')

        return engine
      }
    ],
    [
      'a lock without the toolkit',
      () => {
        const engine = engineRoot()
        writeFileSync(join(engine, ...ENGINE_TOOLKIT_LOCK), JSON.stringify({ browser: {} }))

        return engine
      }
    ],
    ['a pin that is not a sha256', () => engineRoot('5254c8a0')]
  ])('none with %s', (_label, engine) => {
    assert.equal(pinnedOpenfilmToolkit(engine()), null)
  })

  test('the lock Desktop reads is the one the engine installs from, and names this repository’s pin', () => {
    const repo = join(__dirname, '..', '..', '..')
    const lock = JSON.parse(readFileSync(join(repo, ...ENGINE_TOOLKIT_LOCK), 'utf8'))
    const engine = readFileSync(join(repo, 'apex_overlay', 'media_tools.py'), 'utf8')

    assert.equal(pinnedOpenfilmToolkit(repo), lock.openfilm.sha256)
    expect(engine).toContain(`LOCK = ROOT / '${ENGINE_TOOLKIT_LOCK.join('/')}'`)
    // ensure_openfilm installs the toolkit openfilm_pin names, and writes that sha256 into ready.json.
    expect(engine).toMatch(
      /def openfilm_pin\(\) -> dict:[\s\S]*?return json\.loads\(LOCK\.read_text\([^)]*\)\)\['openfilm'\]/
    )
    expect(engine).toMatch(
      /def ensure_openfilm\(\) -> Path:[\s\S]*?spec = openfilm_pin\(\)[\s\S]*?'sha256': spec\['sha256'\]/
    )
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
    const found = findOpenfilmToolkit(plan, PIN)

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
    assert.equal('APEX_OPENFILM_EDITOR_DIR' in env, false)
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

  // hc-1188: GitHub's examples and skills indexes become APEX's empty ones; the library and openfilm.dev a closed port.
  test('none of OpenFilm’s own online sources, for Studio and for every engine alike', () => {
    const plan = onPlan({})
    installToolkit()
    const found = findOpenfilmToolkit(plan, PIN)

    if (!found) {
      throw new Error('no toolkit')
    }

    const offline = {
      OPENFILM_EXAMPLES_INDEX: join(root, 'openfilm', 'offline', 'examples.json'),
      OPENFILM_SKILLS_INDEX: join(root, 'openfilm', 'offline', 'skills.json'),
      OPENFILM_LIBRARY_URL: 'http://127.0.0.1:9',
      OPENFILM_API_URL: 'http://127.0.0.1:9'
    }

    assert.equal(OPENFILM_OFFLINE_URL, 'http://127.0.0.1:9')
    expect(studioChildEnv(plan, found, MAIN_ENV, '/usr/bin')).toMatchObject(offline)
    expect(openfilmAgentEnv(plan)).toMatchObject(offline)
  })

  test('APEX’s editor reaches the host only when the toolkit has it', () => {
    const plan = onPlan({})
    const { toolkit } = installToolkit()
    const editor = addApexEditor(toolkit)
    const found = findOpenfilmToolkit(plan, PIN)

    if (!found) {
      throw new Error('no toolkit')
    }

    assert.equal(studioChildEnv(plan, found, MAIN_ENV, '/usr/bin').APEX_OPENFILM_EDITOR_DIR, editor)
  })

  test('a development toolkit draws in its own Playwright browsers', () => {
    const toolkit = fakeToolkit()
    const plan = onPlan({ [OPENFILM_TOOLKIT_ENV]: toolkit })
    const found = findOpenfilmToolkit(plan, null)

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
  function runStudio({ crash = false, env = onEnv(), engine = engineRoot() } = {}) {
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
      engineRoot: () => engine,
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
      secret: null,
      libraryUrl: OPENFILM_OFFLINE_URL,
      apiUrl: OPENFILM_OFFLINE_URL
    })
    // hc-1188: written before Studio starts, so what it reads in GitHub's place is an index, and an empty one.
    expect(started[0].indexes).toEqual({ examples: { examples: [] }, skills: { version: 1, skills: [] } })

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

  test('a toolkit with APEX’s editor has Studio serve it', async () => {
    const env = onEnv()
    const editor = addApexEditor(String(env[OPENFILM_TOOLKIT_ENV]))
    const { studio } = runStudio({ env })

    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    expect(marks().find(mark => mark.started)?.started).toEqual({
      port: 0,
      stays: true,
      advertise: true,
      editorDir: editor,
      openBrowser: 'function'
    })
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
  function fakeEngine(pins: string = PIN) {
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
            installToolkit(pins)
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

  function studioWith(
    engine: ReturnType<typeof fakeEngine>,
    clock = { now: 1_000 },
    { defaultRoot = engineRoot() as null | string } = {}
  ) {
    const cwd = engineRoot()
    const lines: string[] = []

    const enginePython = vi.fn(async () => ({ command: 'engine-python', cwd, env: { ENGINE_ONLY: '1' } }))

    const studio = createOpenfilmStudio({
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      ...opened(),
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => process.env.PATH ?? '',
      enginePython,
      engineRoot: () => defaultRoot,
      spawn: engine.spawn as never,
      now: () => clock.now,
      log: line => lines.push(line),
      readyTimeoutMs: 20_000
    })

    return { clock, cwd, enginePython, lines, studio }
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
      cwd: join(root, 'engine'),
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

  // hc-1199: what the 0.17.75 candidate got wrong. A machine that had 9890ddff kept it after an update pinned 5254c8a0.
  test('after an update that moved the pin, a film waits for the pinned toolkit, which the engine installs, and Studio runs from it', async () => {
    const { toolkit: old } = installToolkit(OLD_PIN)
    const engine = fakeEngine()
    const { cwd, studio } = studioWith(engine)

    assert.deepEqual(await studio.status(), { on: true, ready: false, preparing: false })

    const first = await studio.open(filmProject('cook'))

    expect(first).toEqual({ ok: false, code: 'not_ready', message: 'the editor is getting ready (started)' })
    assert.equal(marks().length, 0, 'no Studio from the old toolkit')
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    assert.deepEqual(engine.runs[0].args, ['-m', 'apex_overlay.media_tools', 'openfilm'])
    expect(engine.spawn.mock.calls[0][2]).toMatchObject({ cwd })
    assert.equal(await studio.prefetch(), 'preparing')

    engine.runs[0].finish(0)
    await vi.waitFor(async () => assert.deepEqual(await studio.status(), { on: true, ready: true, preparing: false }))
    assert.equal((await studio.open(filmProject('cook'))).ok, true)

    const started = marks().filter(mark => mark.started)

    assert.equal(started.length, 1)
    assert.equal(
      started[0].serverModule,
      join(root, 'tool-cache', 'openfilm', PIN, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs')
    )
    assert.equal(String(started[0].serverModule).startsWith(old), false)
    studio.stop()
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test('after an update that moved the pin, the first video tool installs the pinned toolkit', async () => {
    installToolkit(OLD_PIN)
    const engine = fakeEngine()
    const { studio } = studioWith(engine)

    assert.equal(await studio.prefetch(), 'started')
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    engine.runs[0].finish(0)
    await vi.waitFor(async () => assert.equal(await studio.prefetch(), 'ready'))
  })

  test('once an install has run, the pin of the engine that installed is the one that counts', async () => {
    installToolkit(PIN)
    const engine = fakeEngine()
    // Desktop's own idea of the engine names none: no toolkit counts until the engine says where it runs.
    const { lines, studio } = studioWith(engine, undefined, { defaultRoot: null })

    assert.equal((await studio.status()).ready, false)
    assert.equal(await studio.prefetch(), 'started')
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    engine.runs[0].finish(0)
    await vi.waitFor(async () => assert.deepEqual(await studio.status(), { on: true, ready: true, preparing: false }))
    expect(lines).toContain(
      `[openfilm-studio] installing the toolkit in the background (the engine pins ${PIN.slice(0, 8)}, ready.json names ${PIN.slice(0, 8)})`
    )
  })

  test('a Studio running from the toolkit an earlier pin named gets no new film; the next open restarts it from the pinned one', async () => {
    const engine = fakeEngine()
    const { cwd, lines, studio } = studioWith(engine)
    engineRoot(OLD_PIN)
    installToolkit(OLD_PIN)
    mkdirSync(join(root, 'openfilm'), { recursive: true })
    writeFileSync(join(root, 'openfilm', 'slow-close'), '')

    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    const first = marks().find(mark => mark.started)

    // An engine upgrade activates while APEX runs: the engine's folder now pins the new toolkit.
    assert.equal(engineRoot(PIN), cwd)
    const waiting = await studio.open(filmProject('trip'))

    expect(waiting).toEqual({ ok: false, code: 'not_ready', message: 'the editor is getting ready (started)' })
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    expect(marks().filter(mark => mark.opened)).toEqual([{ opened: 'cook', pid: first?.pid }])
    assert.equal(
      marks().some(mark => mark.closed),
      false,
      'the old Studio keeps what it shows until then'
    )

    engine.runs[0].finish(0)
    await vi.waitFor(async () => assert.equal((await studio.status()).ready, true))
    assert.equal((await studio.open(filmProject('trip'))).ok, true)

    const order = marks()
    const closed = order.findIndex(mark => mark.closed && mark.pid === first?.pid)
    const again = order.findIndex(mark => mark.started && mark.pid !== first?.pid)

    // Desktop ends its own old Studio and waits for it to go: it is not taken for another app's Studio.
    assert.ok(closed >= 0 && again > closed, JSON.stringify(order))
    assert.equal(lines.filter(line => line.includes('restarting Studio')).length, 1)
    assert.equal(
      lines.some(line => line.includes('another Studio')),
      false,
      lines.join('\n')
    )
    assert.equal(
      order[again].serverModule,
      join(root, 'tool-cache', 'openfilm', PIN, 'node_modules', 'openfilm', 'studio', 'server', 'server.mjs')
    )
    expect(order.filter(mark => mark.opened)).toEqual([
      { opened: 'cook', pid: first?.pid },
      { opened: 'trip', pid: order[again].pid }
    ])

    // One Studio of Desktop's own from then on: another open reuses it.
    assert.equal((await studio.open(filmProject('cook'))).ok, true)
    assert.equal(marks().filter(mark => mark.started).length, 2)
    studio.stop()
    await vi.waitFor(() => expect(marks().filter(mark => mark.closed).length).toBe(2), { timeout: 10_000 })
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
      'hermes:openfilmStudio:check',
      'hermes:openfilmStudio:lastProject',
      'hermes:openfilmStudio:open',
      'hermes:openfilmStudio:prefetch',
      'hermes:openfilmStudio:progress',
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

  test('main gives the module the root of the engine it runs (hc-1199), and the install runs at the backend’s root', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    const call = main.slice(main.indexOf('const openfilmStudio = createOpenfilmStudio({'))

    expect(call.slice(0, call.indexOf('\n})'))).toContain(
      'engineRoot: () => openfilmEngineRoot(process.env, { active: ACTIVE_HERMES_ROOT, checkout: SOURCE_REPO_ROOT, diagnostic: IS_DIAGNOSTIC_TRIAL, packaged: IS_PACKAGED, isSource: isHermesSourceRoot }),'
    )
    expect(main).toContain(
      'return backend.command ? { command: backend.command, cwd: backend.root, env: backend.env ?? {} } : null'
    )
    // The roots it names are resolveHermesBackend's own.
    expect(main).toContain("const ACTIVE_HERMES_ROOT = path.join(HERMES_HOME, 'hermes-agent')")
    expect(main).toContain(
      'const overrideRoot = process.env.HERMES_DESKTOP_HERMES_ROOT && path.resolve(process.env.HERMES_DESKTOP_HERMES_ROOT)'
    )
    expect(main).toContain('if (!IS_PACKAGED && isHermesSourceRoot(SOURCE_REPO_ROOT)) {')
  })

  test.each<[string, Record<string, string | undefined>, { diagnostic?: boolean; packaged?: boolean }, string]>([
    ['an installed APEX', {}, { packaged: true }, '/home/hermes-agent'],
    ['a development build in a checkout', {}, { packaged: false }, '/src'],
    ['an explicit source root', { HERMES_DESKTOP_HERMES_ROOT: '/wt' }, { packaged: true }, resolve('/wt')],
    [
      'a Diagnostic Trial’s runtime',
      { HERMES_DESKTOP_HERMES_ROOT: '/trial' },
      { packaged: true, diagnostic: true },
      resolve('/trial')
    ],
    [
      'an explicit root that is not a source root',
      { HERMES_DESKTOP_HERMES_ROOT: '/nothing' },
      { packaged: true },
      '/home/hermes-agent'
    ]
  ])('the engine whose pin counts first: %s', (_label, env, { diagnostic = false, packaged = true }, expected) => {
    const roots = {
      active: '/home/hermes-agent',
      checkout: '/src',
      diagnostic,
      packaged,
      isSource: (folder: string) => ['/src', resolve('/wt')].includes(folder)
    }

    assert.equal(openfilmEngineRoot(env, roots), expected)
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
      OPENFILM_EXAMPLES_INDEX: join(root, 'openfilm', 'offline', 'examples.json'),
      OPENFILM_SKILLS_INDEX: join(root, 'openfilm', 'offline', 'skills.json'),
      OPENFILM_LIBRARY_URL: OPENFILM_OFFLINE_URL,
      OPENFILM_API_URL: OPENFILM_OFFLINE_URL,
      OPENFILM_HOSTED: '1',
      OPENFILM_NO_BROWSER: '1',
      OPENFILM_NO_UPDATE_CHECK: '1'
    })
  })
})

describe('the titlebar’s 剪辑 (hc-1201)', () => {
  /** The engine's two runs main makes for the switch: the install (it prints what the test feeds it) and the check. */
  function fakeEngine() {
    const runs: Array<{ args: string[]; env: Record<string, string | undefined>; proc: any }> = []

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
      runs.push({ args, env: options.env, proc })

      return proc
    })

    return { runs, spawn }
  }

  /** The Scheduler's tools check that notes which Desktop asked (the x-apex-desktop-* headers it got). */
  function noting(open = true) {
    const asked: Array<Record<string, string>> = []

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith('https://scheduler.test')) {
        return fetch(input, init)
      }

      asked.push(Object.fromEntries([...new Headers(init?.headers).entries()]))

      return new Response(JSON.stringify({ ok: true, openfilm: { enabled: open } }), { status: 200 })
    }) as typeof fetch

    return { asked, fetchImpl }
  }

  function studioWith(
    engine: ReturnType<typeof fakeEngine>,
    { env = {}, fetchImpl = scheduler(true), clock = { now: 1_000 } }: Partial<{
      clock: { now: number }
      env: Record<string, string>
      fetchImpl: typeof fetch
    }> = {}
  ) {
    const cwd = engineRoot()
    const lines: string[] = []

    const studio = createOpenfilmStudio({
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env },
      account: () => ACCOUNT,
      fetchImpl,
      hermesHome: root,
      execPath: process.execPath,
      basePath: () => process.env.PATH ?? '',
      enginePython: vi.fn(async () => ({ command: 'engine-python', cwd, env: {} })),
      engineRoot: () => cwd,
      spawn: engine.spawn as never,
      now: () => clock.now,
      log: line => lines.push(line),
      readyTimeoutMs: 20_000
    })

    return { clock, lines, studio }
  }

  const progressLine = (step: string, done: number, total: number) =>
    `${INSTALL_PROGRESS_MARK}${JSON.stringify({ step, done, total })}\n`

  test('main says which Desktop asks, from its own environment; an older environment says nothing', async () => {
    const said = noting()
    const env = { APEX_DESKTOP_VERSION: '0.17.77', APEX_DESKTOP_PLATFORM: 'mac-arm64' }

    await studioWith(fakeEngine(), { env, fetchImpl: said.fetchImpl }).studio.status()
    const silent = noting()
    await studioWith(fakeEngine(), { fetchImpl: silent.fetchImpl }).studio.status()

    assert.equal(said.asked[0]['x-apex-desktop-version'], '0.17.77')
    assert.equal(said.asked[0]['x-apex-desktop-platform'], 'mac-arm64')
    assert.equal(said.asked[0].authorization, 'Bearer apex-key-for-test')
    assert.deepEqual(
      Object.keys(silent.asked[0]).filter(name => name.startsWith('x-apex-desktop-')),
      []
    )
  })

  test('a caller’s header never replaces the account’s key', async () => {
    const said = noting()

    await readOpenfilmAccess({ apiBase: 'https://scheduler.test', key: 'k' }, said.fetchImpl, {
      authorization: 'Bearer someone-else',
      'X-Apex-Desktop-Version': '0.17.77'
    })

    assert.equal(said.asked[0].authorization, 'Bearer k')
    assert.equal(said.asked[0]['x-apex-desktop-version'], '0.17.77')
  })

  test('the install is asked for its progress, which main keeps apart from the reason it gives', async () => {
    const engine = fakeEngine()
    const { lines, studio } = studioWith(engine)

    assert.deepEqual(studio.progress(), { failed: false, progress: null })
    assert.equal(await studio.prefetch(), 'started')
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    const [{ args, env, proc }] = engine.runs

    assert.deepEqual(args, ['-m', 'apex_overlay.media_tools', 'openfilm'])
    assert.equal(env[INSTALL_PROGRESS_ENV], '1')
    // A line split across chunks is read whole.
    const line = progressLine('browser', 50, 200)
    proc.stdout.emit('data', line.slice(0, 20))
    assert.deepEqual(studio.progress(), { failed: false, progress: null })
    proc.stdout.emit('data', line.slice(20))
    assert.deepEqual(studio.progress(), { failed: false, progress: { step: 'browser', done: 50, total: 200 } })
    proc.stdout.emit('data', progressLine('toolkit', 41, 42))
    assert.deepEqual(studio.progress().progress, { step: 'toolkit', done: 41, total: 42 })

    proc.stderr.emit('data', 'APEX OpenFilm toolkit unavailable: URLError: offline\n')
    proc.stdout.emit('data', progressLine('toolkit', 42, 42))
    proc.emit('exit', 1, null)
    await vi.waitFor(async () => assert.equal((await studio.status()).preparing, false))

    assert.deepEqual(studio.progress(), { failed: true, progress: null })
    expect(lines).toContain(
      '[openfilm-studio] toolkit not installed: APEX OpenFilm toolkit unavailable: URLError: offline'
    )
    // A trigger waits after a failure; the person asking does not.
    assert.equal(await studio.prefetch(), 'waiting')
    assert.equal(await studio.prefetch(true), 'started')
    await vi.waitFor(() => assert.equal(engine.runs.length, 2))
    assert.deepEqual(studio.progress(), { failed: false, progress: null })

    installToolkit()
    engine.runs[1].proc.emit('exit', 0, null)
    await vi.waitFor(async () => assert.equal((await studio.status()).ready, true))
    assert.deepEqual(studio.progress(), { failed: false, progress: null })
  })

  test('the first-run check is the engine’s, read only from what it says', async () => {
    const engine = fakeEngine()
    const { studio } = studioWith(engine)
    const answer = { browser: { ready: true, bytes: 190 }, toolkit: { ready: false, bytes: 42 }, disk: { free: 9e9, needed: 126 } }

    const asked = studio.check()
    await vi.waitFor(() => assert.equal(engine.runs.length, 1))
    assert.deepEqual(engine.runs[0].args, ['-m', 'apex_overlay.media_tools', 'openfilm-check'])
    engine.runs[0].proc.stdout.emit('data', `${JSON.stringify(answer)}\n`)
    engine.runs[0].proc.emit('exit', 0, null)
    assert.deepEqual(await asked, answer)

    const failing = studio.check()
    await vi.waitFor(() => assert.equal(engine.runs.length, 2))
    engine.runs[1].proc.stdout.emit('data', `${JSON.stringify(answer)}\n`)
    engine.runs[1].proc.emit('exit', 2, null)
    assert.equal(await failing, null, 'an engine without the command exits 2')
  })

  test('no check for an account the editor is not open to: the engine is not even run', async () => {
    const engine = fakeEngine()
    const { studio } = studioWith(engine, { fetchImpl: scheduler(false) })

    assert.equal(await studio.check(), null)
    expect(engine.spawn).not.toHaveBeenCalled()
  })

  test('the project last opened is kept, and forgotten once it holds no film.html', async () => {
    installToolkit()
    const { studio } = studioWith(fakeEngine())
    const cook = filmProject('cook')

    assert.equal(studio.lastProject(), null)
    assert.equal((await studio.open(cook)).ok, true)
    assert.equal(studio.lastProject(), cook)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'openfilm', LAST_PROJECT_FILE), 'utf8')), { folder: cook })

    rmSync(join(cook, 'film.html'))
    assert.equal(studio.lastProject(), null)
    writeFileSync(join(root, 'openfilm', LAST_PROJECT_FILE), 'not json')
    assert.equal(studio.lastProject(), null)
    studio.stop()
    await vi.waitFor(() => expect(marks().some(mark => mark.closed)).toBe(true), { timeout: 10_000 })
  })

  test.each<[string, string, null | { done: number; step: string; total: number }]>([
    ['a download line', `${INSTALL_PROGRESS_MARK}{"step":"toolkit","done":1,"total":2}`, { step: 'toolkit', done: 1, total: 2 }],
    ['more than all is all', `${INSTALL_PROGRESS_MARK}{"step":"browser","done":9,"total":2}`, { step: 'browser', done: 2, total: 2 }],
    ['an unknown step', `${INSTALL_PROGRESS_MARK}{"step":"music","done":1,"total":2}`, null],
    ['no total', `${INSTALL_PROGRESS_MARK}{"step":"toolkit","done":1,"total":0}`, null],
    ['not JSON', `${INSTALL_PROGRESS_MARK}{`, null],
    ['any other line', 'APEX OpenFilm toolkit unavailable', null]
  ])('reading a progress line: %s', (_label, line, expected) => {
    assert.deepEqual(parseInstallProgress(line), expected)
  })

  test.each<[string, string, boolean]>([
    ['the engine’s answer', '{"browser":{"ready":true,"bytes":1},"toolkit":{"ready":false,"bytes":2},"disk":{"free":3,"needed":4}}', true],
    ['its last line, after anything else', 'warning\n{"browser":{"ready":true,"bytes":1},"toolkit":{"ready":true,"bytes":2},"disk":{"free":3,"needed":0}}', true],
    ['a part without its size', '{"browser":{"ready":true},"toolkit":{"ready":false,"bytes":2},"disk":{"free":3,"needed":4}}', false],
    ['no disk', '{"browser":{"ready":true,"bytes":1},"toolkit":{"ready":false,"bytes":2}}', false],
    ['usage text of an engine without the command', 'usage: media_tools.py [-h]', false]
  ])('reading the check: %s', (_label, text, readable) => {
    assert.equal(parseOpenfilmCheck(text) !== null, readable)
  })

  test('what an install prints: the last other line is the reason, even one with no newline yet', () => {
    const said = installOutput()
    const stdout = said.reader()
    const stderr = said.reader()

    stdout(progressLine('browser', 1, 2))
    stderr('first problem\nAPEX OpenFilm toolkit unavailable: Time')
    stdout(progressLine('browser', 2, 2))
    stderr('outError: slow')
    said.flush()

    assert.equal(said.lastLine(), 'APEX OpenFilm toolkit unavailable: TimeoutError: slow')
    assert.deepEqual(said.progress(), { step: 'browser', done: 2, total: 2 })
  })

  test('registering puts which Desktop this is in main’s environment, and wires the switch’s three asks', async () => {
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
    const env: Record<string, string | undefined> = {}

    const studio = {
      check: vi.fn(() => 'checked'),
      lastProject: vi.fn(() => '/work/cook'),
      open: vi.fn(),
      prefetch: vi.fn((manual?: boolean) => (manual ? 'started' : 'waiting')),
      progress: vi.fn(() => ({ failed: false, progress: null })),
      status: vi.fn(),
      stop: vi.fn(),
      plan: onPlan({})
    }

    registerOpenfilmStudio(
      studio as never,
      { handle: (channel, listener) => handlers.set(channel, listener) },
      { getVersion: () => '0.17.77', on: () => undefined },
      env
    )

    assert.equal(env.APEX_DESKTOP_VERSION, '0.17.77')
    assert.equal(env.APEX_DESKTOP_PLATFORM, desktopPlatform(process.platform, process.arch))
    assert.equal(handlers.get('hermes:openfilmStudio:prefetch')?.({}, true), 'started')
    // Only a real `true` from the window counts as the person asking.
    assert.equal(handlers.get('hermes:openfilmStudio:prefetch')?.({}, 'true'), 'waiting')
    assert.equal(handlers.get('hermes:openfilmStudio:check')?.({}), 'checked')
    assert.equal(handlers.get('hermes:openfilmStudio:lastProject')?.({}), '/work/cook')
    assert.deepEqual(handlers.get('hermes:openfilmStudio:progress')?.({}), { failed: false, progress: null })

    const older: Record<string, string | undefined> = {}
    registerOpenfilmStudio(studio as never, { handle: () => undefined }, { on: () => undefined }, older)
    assert.equal(older.APEX_DESKTOP_VERSION, undefined, 'an app that cannot say its version says nothing')
  })
})
