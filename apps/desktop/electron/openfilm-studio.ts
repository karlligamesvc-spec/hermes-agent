/**
 * openfilm-studio.ts — PROTOTYPE, off unless this install turns it on: OpenFilm
 * Studio as the editor in the preview pane.
 *
 * Studio is OpenFilm's editor (openfilm@0.3.0, MIT): a timeline over an agent's
 * `film.html`, where a person retypes a caption, moves a title or splits a clip,
 * and Studio writes that back into the same files for the agent to read. APEX
 * does not ship it. An install turns it on with APEXNODES_OPENFILM_STUDIO=1 and
 * points APEXNODES_OPENFILM_TOOLKIT at a folder holding `node_modules/openfilm`
 * (and, in `browsers/`, the Chromium Playwright downloads for it). The
 * platform's `desktop_features` cannot turn it on: an install without the
 * toolkit would only get an error.
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import { envSwitch } from './apex-desktop-features'

/** This install's switch: only `1` (or true/yes/on) turns the prototype on. */
export const OPENFILM_STUDIO_ENV = 'APEXNODES_OPENFILM_STUDIO'
/** The folder holding `node_modules/openfilm` (an absolute path). */
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
  | { on: false; reason: 'no_toolkit' | 'switch_off' }
  | { browsers: null | string; dataRoot: string; on: true; serverModule: string; toolkit: string }

/** Whether this launch runs the prototype, and from where. Pure. */
export function planOpenfilmStudio(
  env: Record<string, string | undefined>,
  hermesHome: string,
  exists: (path: string) => boolean = existsSync
): OpenfilmStudioPlan {
  if (envSwitch(env[OPENFILM_STUDIO_ENV]) !== true) {
    return { on: false, reason: 'switch_off' }
  }

  const toolkit = String(env[OPENFILM_TOOLKIT_ENV] ?? '').trim()
  const serverModule = toolkit && isAbsolute(toolkit) ? join(toolkit, ...SERVER_MODULE) : ''

  if (!serverModule || !exists(serverModule)) {
    return { on: false, reason: 'no_toolkit' }
  }

  const browsers = join(toolkit, 'browsers')

  return {
    on: true,
    toolkit,
    serverModule,
    browsers: exists(browsers) ? browsers : null,
    dataRoot: join(hermesHome, 'openfilm')
  }
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
 * folders, no browser of its own and no npm update check, and a PATH that finds
 * the engine's ffmpeg and ffprobe before anything else (OpenFilm looks for them
 * only on PATH). `basePath` is the PATH the engine itself gets, whose first
 * entries are the engine's bundled tools.
 */
export function studioChildEnv(
  plan: Extract<OpenfilmStudioPlan, { on: true }>,
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

  const path = [isAbsolute(ffmpegDir) ? ffmpegDir : '', join(plan.toolkit, 'node_modules', '.bin'), basePath]
    .filter(Boolean)
    .join(delimiter)

  return {
    ...kept,
    ...openfilmStudioFolders(plan.dataRoot),
    OPENFILM_NO_BROWSER: '1',
    OPENFILM_NO_UPDATE_CHECK: '1',
    ...(plan.browsers ? { PLAYWRIGHT_BROWSERS_PATH: plan.browsers } : {}),
    ELECTRON_RUN_AS_NODE: '1',
    APEX_OPENFILM_SERVER_MODULE: plan.serverModule,
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
  | { code: 'not_a_film' | 'off' | 'open_failed' | 'start_failed'; message: string; ok: false }
  | { ok: true; url: string }

export interface OpenfilmStudioDeps {
  /** The PATH the engine gets (its bundled tools first), read when Studio starts. */
  basePath: () => string
  env: Record<string, string | undefined>
  /** This app's binary: run as Node for the host. */
  execPath: string
  exists?: (path: string) => boolean
  fetchImpl?: typeof fetch
  hermesHome: string
  log?: (line: string) => void
  readyTimeoutMs?: number
  spawn?: typeof nodeSpawn
}

export interface OpenfilmStudio {
  /** The Studio address that opens `folder` (a project: it holds film.html), Studio started first if needed. */
  open: (folder: unknown) => Promise<OpenfilmStudioOpen>
  plan: OpenfilmStudioPlan
  status: () => { on: boolean }
  /** Ask Studio to stop (app quit); it also stops by itself when main's pipe closes. */
  stop: () => void
}

export function createOpenfilmStudio(deps: OpenfilmStudioDeps): OpenfilmStudio {
  const log = deps.log ?? (() => undefined)
  const exists = deps.exists ?? existsSync
  const spawn = deps.spawn ?? nodeSpawn
  const fetchImpl = deps.fetchImpl ?? fetch
  const plan = planOpenfilmStudio(deps.env, deps.hermesHome, exists)
  let child: ChildProcess | null = null
  let starting: null | Promise<RunningStudio> = null

  if (deps.env[OPENFILM_STUDIO_ENV] !== undefined) {
    log(
      plan.on === true
        ? `[openfilm-studio] prototype on: toolkit ${plan.toolkit}, data ${plan.dataRoot}`
        : `[openfilm-studio] prototype stays off (${plan.reason})`
    )
  }

  function start(on: Extract<OpenfilmStudioPlan, { on: true }>): Promise<RunningStudio> {
    if (starting) {
      return starting
    }

    const attempt = launch(on)
    starting = attempt
    // A failed start is not kept: the next open tries again.
    attempt.catch(() => {
      if (starting === attempt) {
        starting = null
      }
    })

    return attempt
  }

  function launch(on: Extract<OpenfilmStudioPlan, { on: true }>): Promise<RunningStudio> {
    return new Promise<RunningStudio>((resolve, reject) => {
      mkdirSync(on.dataRoot, { recursive: true })
      const hostFile = join(on.dataRoot, HOST_FILE)
      writeFileSync(hostFile, STUDIO_HOST_SOURCE, { mode: 0o600 })

      const proc = spawn(deps.execPath, [hostFile], {
        cwd: on.dataRoot,
        env: studioChildEnv(on, deps.env, deps.basePath()),
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

    let studio: RunningStudio

    try {
      studio = await start(plan)
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

  return { open, plan, status: () => ({ on: plan.on }), stop }
}
