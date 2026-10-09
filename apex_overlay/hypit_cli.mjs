// Keep the upstream CLI intact; only its dependency source and APEX setup live here.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managedCaptureArgs } from './hypit_capture.mjs'
import { hypitEnvironment } from './hypit_environment.mjs'

const root = path.resolve(import.meta.dirname, '..')
const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts/media-tools/desktop-lock.json'), 'utf8'))
const env = hypitEnvironment(process.env, root, process.execPath, lock.npm.registry)
let args = process.argv.slice(2)
const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const upstream = path.join(root, '.runtime/hypit/node_modules/@hypit/hypit/bin/hypit.mjs')
try {
  const capture = await managedCaptureArgs(args, async () => {
    const { stdout } = await promisify(execFile)(python, ['-m', 'apex_overlay.media_tools', 'browser'],
      { env, windowsHide: true, timeout: 1800000 })
    return stdout.trim()
  })
  if (capture.installed) { console.log(capture.installed); process.exit(0) }
  args = capture.args
} catch (error) {
  console.error(`APEX browser preparation failed: ${error.message}`)
  process.exit(1)
}
const preparing = args[0] === 'apex-prepare'
const command = preparing ? python : process.execPath
const parameters = preparing ? ['-m', 'apex_overlay.media_tools', 'prepare-hypit', ...args.slice(1)] : [upstream, ...args]
const child = spawn(command, parameters, { env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(`Hypit could not start: ${error.message}`); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
