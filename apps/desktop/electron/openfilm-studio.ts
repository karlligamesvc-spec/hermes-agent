/**
 * openfilm-studio.ts — only for an account the server opens it to: OpenFilm
 * Studio as the editor in the preview pane (hc-1173 prototype, hc-1176 toolkit
 * download, hc-1178 per-account switch).
 *
 * Studio is OpenFilm's editor (openfilm@0.3.0, MIT, with APEX's patches): a
 * timeline over an agent's `film.html`, where a person retypes a caption, moves
 * a title or splits a clip, and Studio writes that back into the same files for
 * the agent to read. Whether this account may use it is the Scheduler's answer,
 * `openfilm.enabled` on `/tools/v1/check` with the signed-in account's APEX key
 * (apex-nodes `openfilm_access`: the entitlement `openfilm_editor`, opened per
 * account), kept a minute. There is no install switch and no `desktop_features`
 * key. Signed out, not opened, or unreadable with no earlier answer: no editor,
 * no toolkit, and a film opens as it always did. APEX does not ship the toolkit
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
 * No other Studio outlives APEX (hc-1177). The agent's `openfilm` runs hosted
 * (OPENFILM_HOSTED=1, APEX's patch 0003): it uses this Studio and never starts
 * one. Main's environment carries the same, so whatever else the engine runs
 * with OpenFilm works in APEX's folders, where Desktop sees it in run.json. A
 * Studio run.json names that is not Desktop's is asked to quit before Desktop
 * starts its own, and ended when APEX quits.
 *
 * OpenFilm's own online sources are off (hc-1188, `openfilmOfflineEnv`): no
 * examples or skills index from GitHub, no library download or openfilm.dev
 * service. A toolkit that carries APEX's own build of the editor
 * (`apex-editor/`) has Studio serve that one; any other serves Studio's own.
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

import { type ChildProcess, spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Where the account's answer is: the Scheduler's tools check (apex-nodes `openfilm_access.open_to`). */
export const OPENFILM_CHECK_PATH = '/tools/v1/check'
/** An answer is kept this long; a different account (or key) asks afresh. */
const ACCESS_TTL_MS = 60_000
const ACCESS_TIMEOUT_MS = 5_000
/** A development build's toolkit: the folder holding `node_modules/openfilm` (an absolute path). */
export const OPENFILM_TOOLKIT_ENV = 'APEXNODES_OPENFILM_TOOLKIT'
/** Optional: a folder with ffmpeg + ffprobe put before the engine's own (a dev build runs no installed engine). */
export const OPENFILM_FFMPEG_DIR_ENV = 'APEXNODES_OPENFILM_FFMPEG_DIR'

export const FILM_FILE = 'film.html'
const SERVER_MODULE = ['node_modules', 'openfilm', 'studio', 'server', 'server.mjs']
/** APEX's own build of Studio's editor in a toolkit (hc-1188): a folder with its index.html and assets/. */
export const APEX_EDITOR_DIR = 'apex-editor'
const HOST_FILE = 'apex-studio-host.mjs'
/**
 * Where OpenFilm's own online sources point instead (hc-1188): a closed
 * loopback port, so a library download or an openfilm.dev call fails at once.
 */
export const OPENFILM_OFFLINE_URL = 'http://127.0.0.1:9'
/** Prefix of the host's own stdout lines; anything else on stdout/stderr is Studio's log. */
const HOST_MARK = '@@apex-openfilm '
const READY_TIMEOUT_MS = 60_000
const OPEN_TIMEOUT_MS = 15_000
/** Another Studio asked to quit has this long to answer, and then this long to be gone. */
const QUIT_ANSWER_MS = 3_000
const QUIT_GONE_MS = 5_000
/** A Studio ended at APEX's quit (asked, on macOS and Linux) is ended hard this long after, should it still be there. */
const HARD_END_AFTER_S = 5
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

/** Where Studio's data and its toolkit are. */
export interface OpenfilmStudioPlan {
  dataRoot: string
  devToolkit: null | string
  ready: string
}

/** The toolkit Studio runs from: its folder, its server module, and the browser it draws in. */
export interface OpenfilmToolkit {
  /** A development toolkit's Playwright browsers (PLAYWRIGHT_BROWSERS_PATH). */
  browsers: null | string
  /** The agent browser's Chromium (OPENFILM_CHROMIUM), for the installed toolkit. */
  chromium: null | string
  /** APEX's build of the editor when the toolkit carries one; null: Studio serves its own. */
  editor: null | string
  serverModule: string
  toolkit: string
}

/** Where Studio's data and its toolkit are. Pure. */
export function planOpenfilmStudio(env: Record<string, string | undefined>, hermesHome: string): OpenfilmStudioPlan {
  const devToolkit = String(env[OPENFILM_TOOLKIT_ENV] ?? '').trim()

  return {
    dataRoot: join(hermesHome, 'openfilm'),
    ready: join(hermesHome, 'tool-cache', 'openfilm', 'ready.json'),
    devToolkit: devToolkit || null
  }
}

/** APEX's build of the editor in `toolkit`, or null when it carries none (an older toolkit). */
function apexEditorIn(toolkit: string, exists: (path: string) => boolean): null | string {
  const editor = join(toolkit, APEX_EDITOR_DIR)

  return exists(join(editor, 'index.html')) ? editor : null
}

/**
 * The toolkit Studio can run from now, or null while there is none: a
 * development build's own, else the one the engine installed, as its
 * ready.json names it (written last, so never a half-done install) and only
 * while its files are there. Read each time: the engine may finish at any moment.
 */
export function findOpenfilmToolkit(
  plan: OpenfilmStudioPlan,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = path => readFileSync(path, 'utf8')
): null | OpenfilmToolkit {
  if (plan.devToolkit !== null) {
    const serverModule = isAbsolute(plan.devToolkit) ? join(plan.devToolkit, ...SERVER_MODULE) : ''
    const browsers = join(plan.devToolkit, 'browsers')

    return serverModule && exists(serverModule)
      ? {
          toolkit: plan.devToolkit,
          serverModule,
          browsers: exists(browsers) ? browsers : null,
          chromium: null,
          editor: apexEditorIn(plan.devToolkit, exists)
        }
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

  return { toolkit, serverModule, browsers: null, chromium, editor: apexEditorIn(toolkit, exists) }
}

/** The signed-in APEX account as main holds it: the API base and the account's APEX key. */
export interface ApexAccount {
  apiBase?: null | string
  key?: null | string
}

/**
 * `openfilm.enabled` on the Scheduler's tools check, asked with the account's
 * APEX key: true or false as it says, null when it could not be read.
 */
export async function readOpenfilmAccess(
  account: { apiBase: string; key: string },
  fetchImpl: typeof fetch = fetch
): Promise<boolean | null> {
  try {
    const response = await fetchImpl(`${account.apiBase.replace(/\/+$/, '')}${OPENFILM_CHECK_PATH}`, {
      headers: { authorization: `Bearer ${account.key}` },
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS)
    })

    if (!response.ok) {
      return null
    }

    const said = (await response.json()) as { openfilm?: { enabled?: unknown } } | null

    return said?.openfilm?.enabled === true
  } catch {
    return null
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

/** The empty indexes Studio reads in place of GitHub's (`openfilmOfflineEnv`), in APEX's data folder. */
export function openfilmOfflineIndexes(dataRoot: string): { examples: string; skills: string } {
  return { examples: join(dataRoot, 'offline', 'examples.json'), skills: join(dataRoot, 'offline', 'skills.json') }
}

/**
 * OpenFilm's own online sources, off (hc-1188). Its examples and skills
 * indexes, which Studio reads from GitHub as it starts, are APEX's empty ones
 * (no examples, nothing to discover). Its library's downloads (sounds, music,
 * voice samples, emoji stickers, local models) and the openfilm.dev service
 * (sign-in, its hosted models, library search by meaning, which then searches
 * by words alone) go to OPENFILM_OFFLINE_URL. A person's own services, by
 * their own keys, are untouched.
 */
export function openfilmOfflineEnv(dataRoot: string): Record<string, string> {
  const indexes = openfilmOfflineIndexes(dataRoot)

  return {
    OPENFILM_EXAMPLES_INDEX: indexes.examples,
    OPENFILM_SKILLS_INDEX: indexes.skills,
    OPENFILM_LIBRARY_URL: OPENFILM_OFFLINE_URL,
    OPENFILM_API_URL: OPENFILM_OFFLINE_URL
  }
}

/** Write the empty indexes `openfilmOfflineEnv` names, as Studio starts: a file that does not read is an error to Discover. */
export function writeOpenfilmOfflineIndexes(dataRoot: string): void {
  const indexes = openfilmOfflineIndexes(dataRoot)

  mkdirSync(join(dataRoot, 'offline'), { recursive: true })
  writeFileSync(indexes.examples, `${JSON.stringify({ examples: [] })}\n`)
  writeFileSync(indexes.skills, `${JSON.stringify({ version: 1, skills: [] })}\n`)
}

/**
 * What every process the engine runs gets from main's environment: OpenFilm in
 * Studio's folders, hosted (the CLI never starts a Studio: APEX's patch 0003),
 * no browser window, no npm update check, none of OpenFilm's own online
 * sources. Set on every Desktop, opened to the account or not: it only changes
 * how OpenFilm runs, and keeps any Studio in APEX's folders, where Desktop ends
 * it when APEX quits.
 */
export function openfilmAgentEnv(plan: OpenfilmStudioPlan): Record<string, string> {
  return {
    ...openfilmStudioFolders(plan.dataRoot),
    ...openfilmOfflineEnv(plan.dataRoot),
    OPENFILM_HOSTED: '1',
    OPENFILM_NO_BROWSER: '1',
    OPENFILM_NO_UPDATE_CHECK: '1'
  }
}

/** The Studio a run.json names: OpenFilm writes it in OPENFILM_HOME once Studio listens, and removes it as it stops. */
export interface AdvertisedStudio {
  key: string
  origin: string
  pid: number
  /** The openfilm CLI's supervisor, which starts Studio again if it ends unexpectedly. */
  supervisor: null | number
}

export function readAdvertisedStudio(
  home: string,
  read: (path: string) => string = path => readFileSync(path, 'utf8')
): AdvertisedStudio | null {
  let said: { key?: unknown; origin?: unknown; pid?: unknown; supervisor?: unknown } | null = null

  try {
    said = JSON.parse(read(join(home, 'run.json')))
  } catch {
    return null
  }

  const pid = Number(said?.pid)
  const supervisor = Number(said?.supervisor)

  return Number.isInteger(pid) && pid > 0 && typeof said?.origin === 'string' && typeof said?.key === 'string'
    ? {
        pid,
        supervisor: Number.isInteger(supervisor) && supervisor > 0 ? supervisor : null,
        origin: said.origin,
        key: said.key
      }
    : null
}

/** What Desktop does to a Studio it did not start. */
export interface StudioProcesses {
  alive: (pid: number) => boolean
  /** Its command line names OpenFilm: never a process that took a gone Studio's pid. */
  isOpenfilm: (pid: number) => boolean
  /** Ends it and what it started; returns at once. */
  end: (pid: number) => void
}

export function systemStudioProcesses(
  platform: NodeJS.Platform = process.platform,
  run: typeof spawnSync = spawnSync,
  spawn: typeof nodeSpawn = nodeSpawn
): StudioProcesses {
  const windows = platform === 'win32'

  return {
    alive: pid => {
      try {
        process.kill(pid, 0)

        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    isOpenfilm: pid => {
      const said = windows
        ? run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
            ],
            { encoding: 'utf8', timeout: 10_000, windowsHide: true }
          )
        : run('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 })

      return /openfilm/i.test(String(said.stdout ?? ''))
    },
    end: pid => {
      if (windows) {
        // The whole tree: on Windows a signal ends one process, and the supervisor would start Studio again.
        run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true })

        return
      }

      try {
        // Studio closes on SIGTERM (its supervisor passes it on); whatever is still there a few seconds later is
        // ended hard, by a shell that outlives APEX.
        process.kill(pid, 'SIGTERM')
        spawn('/bin/sh', ['-c', `sleep ${HARD_END_AFTER_S}; kill -9 ${pid} 2>/dev/null`], {
          detached: true,
          stdio: 'ignore'
        }).unref()
      } catch {
        // gone already
      }
    }
  }
}

/**
 * The child's whole environment: a short list kept from main's, Studio's
 * folders, no browser window of its own, no npm update check and none of
 * OpenFilm's online sources, the browser it draws in, APEX's editor when the
 * toolkit has it, and a PATH that finds the engine's ffmpeg and ffprobe before
 * anything else (OpenFilm looks for them only on PATH). `basePath` is the PATH
 * the engine itself gets, whose first entries are the engine's bundled tools.
 */
export function studioChildEnv(
  plan: OpenfilmStudioPlan,
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
    ...openfilmOfflineEnv(plan.dataRoot),
    OPENFILM_NO_BROWSER: '1',
    OPENFILM_NO_UPDATE_CHECK: '1',
    ...(toolkit.chromium ? { OPENFILM_CHROMIUM: toolkit.chromium } : {}),
    ...(toolkit.browsers ? { PLAYWRIGHT_BROWSERS_PATH: toolkit.browsers } : {}),
    ...(toolkit.editor ? { APEX_OPENFILM_EDITOR_DIR: toolkit.editor } : {}),
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
 * `editorDir` only when the toolkit has APEX's editor: Studio's default otherwise.
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
    ...(process.env.APEX_OPENFILM_EDITOR_DIR ? { editorDir: process.env.APEX_OPENFILM_EDITOR_DIR } : {}),
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
  /** The signed-in account (read each time: sign-in, sign-out and key changes count at once); null signed out. */
  account?: () => ApexAccount | null | undefined
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
  /** What is done to a Studio Desktop did not start (system calls by default). */
  processes?: StudioProcesses
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
  prefetch: () => Promise<'off' | 'preparing' | 'ready' | 'started' | 'waiting'>
  status: () => Promise<OpenfilmStudioStatus>
  /** App quit: Studio stops (it also does when main's pipe closes), and so does any other in APEX's folders. */
  stop: () => void
}

export function createOpenfilmStudio(deps: OpenfilmStudioDeps): OpenfilmStudio {
  const log = deps.log ?? (() => undefined)
  const exists = deps.exists ?? existsSync
  const spawn = deps.spawn ?? nodeSpawn
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const plan = planOpenfilmStudio(deps.env, deps.hermesHome)
  const processes = deps.processes ?? systemStudioProcesses()
  /** Other Studios that would not quit when Desktop started its own: ended at APEX's quit. */
  const others = new Map<number, AdvertisedStudio>()
  let child: ChildProcess | null = null
  let starting: null | Promise<RunningStudio> = null
  let installing: null | Promise<boolean> = null
  let failedAt: null | number = null
  /** The last answer, for which account (a digest of its base and key), and when. */
  let access: null | { at: number; open: boolean; slot: string } = null
  let asking: null | { answer: Promise<boolean>; slot: string } = null

  const toolkitNow = () => findOpenfilmToolkit(plan, exists)

  /**
   * May this account use the editor: the Scheduler's answer, kept a minute. A
   * different account asks afresh; signed out is no. An answer that cannot be
   * read keeps this account's last one (a network blip does not take the editor
   * away mid-edit), or is no when there is none, and is asked again a minute on.
   */
  async function allowed(): Promise<boolean> {
    const account = deps.account?.()
    const apiBase = String(account?.apiBase ?? '').trim()
    const key = String(account?.key ?? '').trim()

    if (!apiBase || !key) {
      return false
    }

    const slot = createHash('sha256').update(`${apiBase}\0${key}`).digest('hex')

    if (access?.slot === slot && now() - access.at < ACCESS_TTL_MS) {
      return access.open
    }

    if (asking?.slot !== slot) {
      const answer = readOpenfilmAccess({ apiBase, key }, fetchImpl).then(said => {
        const open = said ?? (access?.slot === slot ? access.open : false)

        if (access?.slot !== slot || access.open !== open) {
          log(`[openfilm-studio] the editor is ${open ? 'open' : 'not open'} to this account`)
        }

        access = { slot, open, at: now() }

        return open
      })

      asking = { slot, answer }
      void answer.finally(() => {
        if (asking?.answer === answer) {
          asking = null
        }
      })
    }

    return asking.answer
  }

  async function prefetch(): ReturnType<OpenfilmStudio['prefetch']> {
    if (!(await allowed())) {
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

  function start(on: OpenfilmStudioPlan, toolkit: OpenfilmToolkit): Promise<RunningStudio> {
    if (starting) {
      return starting
    }

    const attempt = stopOthers(on).then(() => launch(on, toolkit))
    starting = attempt
    // A failed start is not kept: the next open tries again.
    attempt.catch(() => {
      if (starting === attempt) {
        starting = null
      }
    })

    return attempt
  }

  /**
   * A Studio run.json names that is not Desktop's: one the openfilm CLI started
   * (an agent's `look` or `render` before any film was opened, from a toolkit
   * without APEX's patch 0003). Desktop does not take it over (it was started
   * with someone else's environment, and the CLI may replace it): it is asked to
   * quit, then ended if it does not go. Another app's own (it answers 423) is
   * left to that app.
   */
  async function stopOthers(on: OpenfilmStudioPlan): Promise<void> {
    const other = readAdvertisedStudio(openfilmStudioFolders(on.dataRoot).OPENFILM_HOME)

    if (!other || !processes.alive(other.pid)) {
      return
    }

    const answer = await fetchImpl(`${other.origin}/api/quit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-key': other.key },
      body: '{}',
      signal: AbortSignal.timeout(QUIT_ANSWER_MS)
    })
      .then(response => response.status)
      .catch(() => 0)

    if (answer === 423) {
      log(`[openfilm-studio] another app's Studio runs in APEX's folders (pid ${other.pid}); left to that app`)

      return
    }

    const gone = () => !processes.alive(other.pid) && !(other.supervisor && processes.alive(other.supervisor))

    const goneWithin = async (ms: number) => {
      for (let waited = 0; !gone() && waited < ms; waited += 100) {
        await new Promise(done => setTimeout(done, 100))
      }

      return gone()
    }

    if ((answer === 200 && (await goneWithin(QUIT_GONE_MS))) || (end(other) && (await goneWithin(QUIT_GONE_MS)))) {
      log(`[openfilm-studio] stopped another Studio in APEX's folders (pid ${other.pid})`)

      return
    }

    // Still there (or its pid is now another program's): looked at again when APEX quits.
    others.set(other.pid, other)
  }

  /** Ends another Studio's processes, each only while its command line still names OpenFilm. */
  function end(other: AdvertisedStudio): boolean {
    let ended = false

    for (const pid of [other.supervisor, other.pid]) {
      if (pid && processes.alive(pid) && processes.isOpenfilm(pid)) {
        processes.end(pid)
        ended = true
      }
    }

    return ended
  }

  function launch(on: OpenfilmStudioPlan, toolkit: OpenfilmToolkit): Promise<RunningStudio> {
    return new Promise<RunningStudio>((resolve, reject) => {
      mkdirSync(on.dataRoot, { recursive: true })
      writeOpenfilmOfflineIndexes(on.dataRoot)
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
    if (typeof folder !== 'string' || !isAbsolute(folder) || !exists(join(folder, FILM_FILE))) {
      return { ok: false, code: 'not_a_film', message: `not a folder with ${FILM_FILE}` }
    }

    if (!(await allowed())) {
      return { ok: false, code: 'off', message: 'the editor is not open to this account' }
    }

    const toolkit = toolkitNow()

    if (!toolkit) {
      // The film opens as it always did meanwhile; the toolkit is fetched now if it was not already.
      return { ok: false, code: 'not_ready', message: `the editor is getting ready (${await prefetch()})` }
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
    stopOwn()

    // Any other Studio in APEX's folders ends with APEX: the one run.json names now, and any that would not quit.
    const named = readAdvertisedStudio(openfilmStudioFolders(plan.dataRoot).OPENFILM_HOME)

    if (named && named.pid !== child?.pid) {
      others.set(named.pid, named)
    }

    for (const other of others.values()) {
      if (end(other)) {
        log(`[openfilm-studio] ended another Studio in APEX's folders (pid ${other.pid}) as APEX quits`)
      }
    }

    others.clear()
  }

  function stopOwn() {
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

  const status = async (): Promise<OpenfilmStudioStatus> => {
    const on = await allowed()

    return { on, ready: on && toolkitNow() !== null, preparing: on && installing !== null }
  }

  return { open, plan, prefetch, status, stop }
}

/**
 * Main's side: the window asks for the status, a Studio address, a background
 * install; quitting stops Studio. Main's environment (`env`, which every engine
 * started after this inherits) gets `openfilmAgentEnv`.
 */
export function registerOpenfilmStudio(
  studio: OpenfilmStudio,
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void },
  app: { on(event: 'will-quit', listener: () => void): unknown },
  env: Record<string, string | undefined> = process.env
): void {
  Object.assign(env, openfilmAgentEnv(studio.plan))

  ipcMain.handle('hermes:openfilmStudio:status', () => studio.status())
  ipcMain.handle('hermes:openfilmStudio:open', (_event, folder) => studio.open(folder))
  ipcMain.handle('hermes:openfilmStudio:prefetch', () => studio.prefetch())
  app.on('will-quit', () => studio.stop())
}
