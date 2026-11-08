// `openfilm` in APEX's engine (hc-1177): OpenFilm's own CLI, unchanged, from the toolkit the engine installed
// (apex_overlay/media_tools.py ensure_openfilm, installed first when it is not yet), run with the folders of the
// editor Desktop shows, so `openfilm look` finds that Studio and tells the Agent what the person changed; with no
// browser window, the Agent browser's Chromium, and APEX's ffmpeg first on PATH. Off, like the editor, unless the
// editor is open to this account (apex_overlay/film_project.py asks the Scheduler, and says what to run with).
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')

// APEX pins OpenFilm with its own patches (scripts/media-tools/openfilm): `openfilm update` would fetch the newest from
// npm in its place. The toolkit updates with APEX.
if (process.argv[2] === 'update') {
  console.error('APEX 钉住了 OpenFilm 的版本(带 APEX 的补丁),它随 APEX 一起更新：不用 openfilm update')
  process.exit(2)
}
const venvPython = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
// Desktop gives Agent commands its engine's interpreter as APEX_PYTHON (backend-env.ts, hc-926).
const python = process.env.APEX_PYTHON && fs.existsSync(process.env.APEX_PYTHON) ? process.env.APEX_PYTHON : venvPython

let setup
try {
  const { stdout } = await promisify(execFile)(python, ['-m', 'apex_overlay.film_project', 'env'], {
    cwd: root,
    env: process.env,
    timeout: 45 * 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  })
  setup = JSON.parse(stdout)
} catch (error) {
  console.error(String(error?.stderr || error?.message || error).trim() || 'APEX OpenFilm toolkit unavailable')
  process.exit(error?.code === 2 ? 2 : 1)
}

const bin = path.join(root, '.runtime', 'bin')
const env = { ...process.env, ...setup.env, PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }
const child = spawn(process.execPath, [setup.cli, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
child.on('error', error => {
  console.error(`openfilm could not start: ${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
