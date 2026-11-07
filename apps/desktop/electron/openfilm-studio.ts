/**
 * openfilm-studio.ts — off unless this install turns it on: OpenFilm Studio as
 * the editor in the preview pane (hc-1173 prototype, hc-1176 toolkit download).
 *
 * Studio is OpenFilm's editor (openfilm@0.3.0, MIT, with APEX's patches): a
 * timeline over an agent's `film.html`, where a person retypes a caption, moves
 * a title or splits a clip, and Studio writes that back into the same files for
 * the agent to read. An install turns it on with APEXNODES_OPENFILM_STUDIO=1
 * (the platform's `desktop_features` cannot). APEX does not ship the toolkit
 * Studio runs from: the engine downloads it from APEX COS
 * (`python -m apex_overlay.media_tools openfilm`), in the background the first
 * time an agent works on a video (`prefetch`), and names it in
 * `<HERMES_HOME>/tool-cache/openfilm/ready.json`, written last. It draws in the
 * agent browser's Chromium (OPENFILM_CHROMIUM). Until then a film opens as it
 * always did. A development build may instead point APEXNODES_OPENFILM_TOOLKIT
 * at a folder holding `node_modules/openfilm` (and Playwright's `browsers/`).
 *
 * Studio runs in a child process: this app's own binary run as Node
 * (ELECTRON_RUN_AS_NODE), running a small host that calls `startStudio()` from
 * `openfilm/studio`, with `stays` (the openfilm CLI cannot stop it) and
 * `advertise` (its run.json, in APEX's OPENFILM_HOME, is how an `openfilm` CLI
 * with the same home finds it). A child rather than main, so that its PATH (the
 * engine's ffmpeg first), its OPENFILM_* folders and Playwright's browser folder
 * reach Studio and its workers only, so that it never sees main's environment
 * (`studioChildEnv` passes a short list), and so that a Studio crash is not an
 * APEX crash. The host's stdin is a pipe from main: when APEX goes, Studio goes.
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import { envSwitch } from './apex-desktop-features'

/** This install's switch: only `1` (or true/yes/on) turns it on. */
export const OPENFILM_STUDIO_ENV = 'APEXNODES_OPENFILM_STUDIO'
/** A development build's toolkit: the folder holding `node_modules/openfilm` (an absolute path). */
export const OPENFILM_TOOLKIT_ENV = 'APEXNODES_OPENFILM_TOOLKIT'
/** Optional: a folder with ffmpeg + ffprobe put before the engine's own (a dev build runs no installed engine). */
export const OPENFILM_FFMPEG_DIR_ENV = 'APEXNODES_OPENFILM_FFMPEG_DIR'

export const FILM_FILE = 'film.html'
const SERVER_MODULE = ['node_modules', 'openfilm', 'studio', 'server', 'server.mjs']
const HOST_FILE = 'apex-studio-host.mjs'
/** Prefix of the host's own stdout lines; anything else on stdout/stderr is Studio's log. */
const HOST_MARK = '@@apex-openfilm '
const READY_TIMEOUT_MS = 60_000
const OPEN_TIMEOUT_MS = 15_000
/** The engine's install of the toolkit (and of the Chromium it draws in) may take this long on a slow line. */
const INSTALL_TIMEOUT_MS = 45 * 60_000
/** After a failed install, a new one waits this long, then starts on the next trigger: no retry storm, no prompt. */
const RETRY_AFTER_MS = 10 * 60_000
/** The engine module that installs the toolkit and writes ready.json. */
const INSTALL_ARGS = ['-m', 'apex_overlay.media_tools', 'openfilm']

/** The variables of main's environment the child keeps; everything else stays in main. */
const KEPT_ENV = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA'
]

export type OpenfilmStudioPlan =
  { on: false; reason: 'switch_off' } | { dataRoot: string; devToolkit: null | string; on: true; ready: string }

/** The toolkit Studio runs from: its folder, its server module, and the browser it draws in. */
export interface OpenfilmToolkit {
  /** A development toolkit's Playwright browsers (PLAYWRIGHT_BROWSERS_PATH). */
  browsers: null | string
  /** The agent browser's Chromium (OPENFILM_CHROMIUM), for the installed toolkit. */
  chromium: null | string
  serverModule: string
  toolkit: string
}

/** Whether this launch runs Studio, and where its data and its toolkit are. Pure. */
export function planOpenfilmStudio(env: Record<string, string | undefined>, hermesHome: string): OpenfilmStudioPlan {
  if (envSwitch(env[OPENFILM_STUDIO_ENV]) !== true) {
    return { on: false, reason: 'switch_off' }
  }

  const devToolkit = String(env[OPENFILM_TOOLKIT_ENV] ?? '').trim()

  return {
    on: true,
    dataRoot: join(hermesHome, 'openfilm'),
    ready: join(hermesHome, 'tool-cache', 'openfilm', 'ready.json'),
    devToolkit: devToolkit || null
  }
}

/**
 * The toolkit Studio can run from now, or null while there is none: a
 * development build's own, else the one the engine installed, as its
 * ready.json names it (written last, so never a half-done install) and only
 * while its files are there. Read each time: the engine may finish at any moment.
 */
export function findOpenfilmToolkit(
  plan: Extract<OpenfilmStudioPlan, { on: true }>,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = path => readFileSync(path, 'utf8')
): null | OpenfilmToolkit {
  if (plan.devToolkit !== null) {
    const serverModule = isAbsolute(plan.devToolkit) ? join(plan.devToolkit, ...SERVER_MODULE) : ''
    const browsers = join(plan.devToolkit, 'browsers')

    return serverModule && exists(serverModule)
      ? { toolkit: plan.devToolkit, serverModule, browsers: exists(browsers) ? browsers : null, chromium: null }
      : null
  }

  let said: { chromium?: unknown; toolkit?: unknown } | null = null

  try {
    said = JSON.parse(read(plan.ready))
  } catch {
    return null
  }

  const toolkit = typeof said?.toolkit === 'string' && isAbsolute(said.toolkit) ? said.toolkit : ''
  const chromium = typeof said?.chromium === 'string' && isAbsolute(said.chromium) ? said.chromium : ''
  const serverModule = toolkit ? join(toolkit, ...SERVER_MODULE) : ''

  if (!serverModule || !exists(serverModule) || !chromium || !exists(chromium)) {
    return null
  }

  return { toolkit, serverModule, browsers: null, chromium }
}

/** Studio's folders, all inside APEX's data folder (never ~/.openfilm or ~/Movies/OpenFilm). */
export function openfilmStudioFolders(dataRoot: string): Record<string, string> {
  return {
    OPENFILM_HOME: join(dataRoot, 'home'),
    OPENFILM_LIBRARY: join(dataRoot, 'projects'),
    OPENFILM_SAVED: join(dataRoot, 'saved'),
    OPENFILM_SKILLS: join(dataRoot, 'skills'),
    OPENFILM_EXPORTS: join(dataRoot, 'exports')
  }
}

/**
 * The child's whole environment: a short list kept from main's, Studio's
 * folders, no browser window of its own and no npm update check, the browser
 * it draws in, and a PATH that finds the engine's ffmpeg and ffprobe before
 * anything else (OpenFilm looks for them only on PATH). `basePath` is the PATH
 * the engine itself gets, whose first entries are the engine's bundled tools.
 */
export function studioChildEnv(
  plan: Extract<OpenfilmStudioPlan, { on: true }>,
  toolkit: OpenfilmToolkit,
  env: Record<string, string | undefined>,
  basePath: string
): Record<string, string> {
  const kept: Record<string, string> = {}

  for (const name of KEPT_ENV) {
    const value = env[name]

    if (typeof value === 'string' && value) {
      kept[name] = value
    }
  }

  const ffmpegDir = String(env[OPENFILM_FFMPEG_DIR_ENV] ?? '').trim()

  const path = [isAbsolute(ffmpegDir) ? ffmpegDir : '', join(toolkit.toolkit, 'node_modules', '.bin'), basePath]
    .filter(Boolean)
    .join(delimiter)

  return {
    ...kept,
    ...openfilmStudioFolders(plan.dataRoot),
    OPENFILM_NO_BROWSER: '1',
    OPENFILM_NO_UPDATE_CHECK: '1',
    ...(toolkit.chromium ? { OPENFILM_CHROMIUM: toolkit.chromium } : {}),
    ...(toolkit.browsers ? { PLAYWRIGHT_BROWSERS_PATH: toolkit.browsers } : {}),
    ELECTRON_RUN_AS_NODE: '1',
    APEX_OPENFILM_SERVER_MODULE: toolkit.serverModule,
    PATH: path
  }
}

/**
 * The host the child runs. A file, not `-e`: Studio forks its render workers
 * with this process's execArgv, and an `-e` would run the host again in each.
 * `openBrowser` (sign-in, the desktop-app download, an agent's `open` when no
 * page shows the project) is reported to main, never a browser opened.
 */
export const STUDIO_HOST_SOURCE = `// Written by APEX Desktop (electron/openfilm-studio.ts) on every Studio start. Prototype; do not edit.
import { fstatSync, openSync } from 'node:fs'
import { devNull, setPriority } from 'node:os'
import { pathToFileURL } from 'node:url'

for (const fd of [0, 1, 2]) {
  try { fstatSync(fd) } catch { openSync(devNull, fd === 0 ? 'r' : 'a') }
}
try { setPriority(10) } catch {}

const MARK = ${JSON.stringify(HOST_MARK)}
const say = message => { try { process.stdout.write(MARK + JSON.stringify(message) + '\\n') } catch {} }
let studio = null
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  setTimeout(() => process.exit(0), 5000).unref()
  try { await studio?.close() } catch {}
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdin.resume()
process.on('uncaughtException', error => { say({ type: 'problem', message: String(error?.stack ?? error) }); process.exit(1) })
process.on('unhandledRejection', error => { say({ type: 'problem', message: String(error?.stack ?? error) }) })

try {
  const { startStudio } = await import(pathToFileURL(process.env.APEX_OPENFILM_SERVER_MODULE).href)
  studio = await startStudio({
    port: 0,
    stays: true,
    advertise: true,
    openBrowser: url => say({ type: 'open-browser', url: String(url) })
  })
  say({ type: 'ready', origin: studio.origin, filmOrigin: studio.filmOrigin, key: studio.key })
} catch (error) {
  say({ type: 'failed', message: String(error?.message ?? error) })
  process.exit(1)
}
`

/** Studio's launch key never reaches a log. */
export function redactStudioKey(text: string): string {
  return text.replace(/([?&]key=)[^&\s"]+/g, '$1…')
}

interface RunningStudio {
  key: string
  origin: string
}

export type OpenfilmStudioOpen =
  | { code: 'not_a_film' | 'not_ready' | 'off' | 'open_failed' | 'start_failed'; message: string; ok: false }
  | { ok: true; url: string }

/** How main runs the engine's Python: its interpreter, the folder its modules resolve from, the variables it adds. */
export interface EnginePython {
  command: string
  cwd: string
  env: Record<string, string | undefined>
}

export interface OpenfilmStudioDeps {
  /** The PATH the engine gets (its bundled tools first), read when Studio starts. */
  basePath: () => string
  /** The engine's Python, to install the toolkit with; null when there is no engine yet. */
  enginePython?: () => Promise<EnginePython | null>
  env: Record<string, string | undefined>
  /** This app's binary: run as Node for the host. */
  execPath: string
  exists?: (path: string) => boolean
  fetchImpl?: typeof fetch
  hermesHome: string
  log?: (line: string) => void
  now?: () => number
  readyTimeoutMs?: number
  spawn?: typeof nodeSpawn
}

export interface OpenfilmStudioStatus {
  on: boolean
  /** The engine is installing the toolkit now. */
  preparing: boolean
  /** A toolkit is there: a film opens in Studio. */
  ready: boolean
}

export interface OpenfilmStudio {
  /** The Studio address that opens `folder` (a project: it holds film.html), Studio started first if needed. */
  open: (folder: unknown) => Promise<OpenfilmStudioOpen>
  plan: OpenfilmStudioPlan
  /** Have the engine install the toolkit in the background, unless it is there, on its way, or just failed. */
  prefetch: () => 'off' | 'preparing' | 'ready' | 'started' | 'waiting'
  status: () => OpenfilmStudioStatus
  /** Ask Studio to stop (app quit); it also stops by itself when main's pipe closes. */
  stop: () => void
}

export function createOpenfilmStudio(deps: OpenfilmStudioDeps): OpenfilmStudio {
  const log = deps.log ?? (() => undefined)
  const exists = deps.exists ?? existsSync
  const spawn = deps.spawn ?? nodeSpawn
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const plan = planOpenfilmStudio(deps.env, deps.hermesHome)
  let child: ChildProcess | null = null
  let starting: null | Promise<RunningStudio> = null
  let installing: null | Promise<boolean> = null
  let failedAt: null | number = null

  if (deps.env[OPENFILM_STUDIO_ENV] !== undefined) {
    log(
      plan.on === true
        ? `[openfilm-studio] on: data ${plan.dataRoot}, toolkit ${plan.devToolkit ?? plan.ready}`
        : `[openfilm-studio] stays off (${plan.reason})`
    )
  }

  const toolkitNow = () => (plan.on === true ? findOpenfilmToolkit(plan, exists) : null)

  function prefetch(): ReturnType<OpenfilmStudio['prefetch']> {
    if (plan.on === false) {
      return 'off'
    }

    if (toolkitNow()) {
      return 'ready'
    }

    if (installing) {
      return 'preparing'
    }

    if (failedAt !== null && now() - failedAt < RETRY_AFTER_MS) {
      return 'waiting'
    }

    const attempt = install()
    installing = attempt
    void attempt.then(ok => {
      installing = null
      failedAt = ok ? null : now()
    })

    return 'started'
  }

  /** The engine installs the toolkit and the browser it draws in, then writes ready.json; true once it has. */
  async function install(): Promise<boolean> {
    let engine: EnginePython | null = null

    try {
      engine = (await deps.enginePython?.()) ?? null
    } catch (error) {
      log(`[openfilm-studio] no engine to install the toolkit with: ${error instanceof Error ? error.message : error}`)
    }

    if (!engine) {
      return false
    }

    log('[openfilm-studio] installing the toolkit in the background')

    return new Promise<boolean>(resolve => {
      let said = ''
      let timer: ReturnType<typeof setTimeout> | undefined
      let proc: ChildProcess

      const done = (ok: boolean, why: string) => {
        clearTimeout(timer)
        log(ok ? '[openfilm-studio] toolkit installed' : `[openfilm-studio] toolkit not installed: ${why}`)
        resolve(ok)
      }

      try {
        proc = spawn(engine.command, INSTALL_ARGS, {
          cwd: engine.cwd,
          // As the engine runs: main's environment, APEX's data folder, the engine's own variables.
          env: { ...deps.env, HERMES_HOME: deps.hermesHome, ...engine.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        done(false, error instanceof Error ? error.message : String(error))

        return
      }

      for (const stream of [proc.stdout, proc.stderr]) {
        stream?.setEncoding('utf8')
        stream?.on('data', (chunk: string) => {
          said = (said + chunk).slice(-2000)
        })
      }

      timer = setTimeout(() => proc.kill(), INSTALL_TIMEOUT_MS)
      proc.once('error', error => done(false, error.message))
      proc.once('exit', (code, signal) => {
        const last = said.trim().split(/\r?\n/).pop() ?? ''
        done(code === 0 && toolkitNow() !== null, last || `exit ${signal ?? code}`)
      })
    })
  }

  function start(on: Extract<OpenfilmStudioPlan, { on: true }>, toolkit: OpenfilmToolkit): Promise<RunningStudio> {
    if (starting) {
      return starting
    }

    const attempt = launch(on, toolkit)
    starting = attempt
    // A failed start is not kept: the next open tries again.
    attempt.catch(() => {
      if (starting === attempt) {
        starting = null
      }
    })

    return attempt
  }

  function launch(on: Extract<OpenfilmStudioPlan, { on: true }>, toolkit: OpenfilmToolkit): Promise<RunningStudio> {
    return new Promise<RunningStudio>((resolve, reject) => {
      mkdirSync(on.dataRoot, { recursive: true })
      const hostFile = join(on.dataRoot, HOST_FILE)
      writeFileSync(hostFile, STUDIO_HOST_SOURCE, { mode: 0o600 })

      const proc = spawn(deps.execPath, [hostFile], {
        cwd: on.dataRoot,
        env: studioChildEnv(on, toolkit, deps.env, deps.basePath()),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      child = proc
      const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (error: Error | null, running?: RunningStudio) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)

        if (error || !running) {
          reject(error ?? new Error('Studio failed to start'))
        } else {
          resolve(running)
        }
      }

      timer = setTimeout(() => {
        settle(new Error(`Studio did not start within ${Math.round(readyTimeoutMs / 1000)} s`))
        proc.kill('SIGTERM')
      }, readyTimeoutMs)

      const onLine = (line: string) => {
        if (!line.startsWith(HOST_MARK)) {
          if (line.trim()) {
            log(`[openfilm-studio] ${redactStudioKey(line).slice(0, 500)}`)
          }

          return
        }

        let message: { key?: unknown; message?: unknown; origin?: unknown; type?: unknown; url?: unknown } = {}

        try {
          message = JSON.parse(line.slice(HOST_MARK.length))
        } catch {
          return
        }

        if (message.type === 'ready' && typeof message.origin === 'string' && typeof message.key === 'string') {
          log(`[openfilm-studio] Studio at ${message.origin} (pid ${proc.pid})`)
          settle(null, { origin: message.origin, key: message.key })
        } else if (message.type === 'failed') {
          settle(new Error(String(message.message ?? 'Studio failed to start')))
        } else if (message.type === 'open-browser') {
          log(`[openfilm-studio] Studio asked to open ${redactStudioKey(String(message.url))} in a browser; not opened`)
        } else if (message.type === 'problem') {
          log(`[openfilm-studio] problem: ${redactStudioKey(String(message.message)).slice(0, 500)}`)
        }
      }

      for (const stream of [proc.stdout, proc.stderr]) {
        let buffered = ''

        stream?.setEncoding('utf8')
        stream?.on('data', (chunk: string) => {
          buffered += chunk
          const lines = buffered.split(/\r?\n/)
          buffered = lines.pop() ?? ''
          lines.forEach(onLine)
        })
      }

      // Gone (a crash, a kill, a spawn error): the next open starts a new one.
      const forget = () => {
        if (child === proc) {
          child = null
          starting = null
        }
      }

      proc.once('error', error => {
        forget()
        settle(error)
      })
      proc.once('exit', (code, signal) => {
        log(`[openfilm-studio] Studio ended (${signal ?? `exit code ${code}`})`)
        forget()
        settle(new Error(`Studio ended before it was ready (${signal ?? `exit code ${code}`})`))
      })
    })
  }

  async function open(folder: unknown): Promise<OpenfilmStudioOpen> {
    if (plan.on === false) {
      return { ok: false, code: 'off', message: `OpenFilm Studio is off (${plan.reason})` }
    }

    if (typeof folder !== 'string' || !isAbsolute(folder) || !exists(join(folder, FILM_FILE))) {
      return { ok: false, code: 'not_a_film', message: `not a folder with ${FILM_FILE}` }
    }

    const toolkit = toolkitNow()

    if (!toolkit) {
      // The film opens as it always did meanwhile; the toolkit is fetched now if it was not already.
      return { ok: false, code: 'not_ready', message: `the editor is getting ready (${prefetch()})` }
    }

    let studio: RunningStudio

    try {
      studio = await start(plan, toolkit)
    } catch (error) {
      return { ok: false, code: 'start_failed', message: error instanceof Error ? error.message : String(error) }
    }

    try {
      // fallback 0: Studio never opens a browser of its own when no page shows the project yet.
      const response = await fetchImpl(`${studio.origin}/api/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-studio-key': studio.key },
        body: JSON.stringify({ path: folder, fallback: 0 }),
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS)
      })

      const said = (await response.json().catch(() => null)) as { error?: unknown; url?: unknown } | null

      if (!response.ok || typeof said?.url !== 'string') {
        return { ok: false, code: 'open_failed', message: String(said?.error ?? `Studio answered ${response.status}`) }
      }

      return { ok: true, url: said.url }
    } catch (error) {
      return { ok: false, code: 'open_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  function stop() {
    const proc = child

    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return
    }

    // The host stops Studio when its stdin ends: a clean close (its servers, its
    // run.json) on every platform, where a signal on Windows is a hard kill.
    proc.stdin?.end()
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }, 8_000).unref()
  }

  const status = (): OpenfilmStudioStatus => ({
    on: plan.on,
    ready: toolkitNow() !== null,
    preparing: installing !== null
  })

  return { open, plan, prefetch, status, stop }
}

/** Main's side: the window asks for the status, a Studio address, a background install; quitting stops Studio. */
export function registerOpenfilmStudio(
  studio: OpenfilmStudio,
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void },
  app: { on(event: 'will-quit', listener: () => void): unknown }
): void {
  ipcMain.handle('hermes:openfilmStudio:status', () => studio.status())
  ipcMain.handle('hermes:openfilmStudio:open', (_event, folder) => studio.open(folder))
  ipcMain.handle('hermes:openfilmStudio:prefetch', () => studio.prefetch())
  app.on('will-quit', () => studio.stop())
}
