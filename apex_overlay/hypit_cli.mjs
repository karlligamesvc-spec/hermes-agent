// Keep the upstream CLI intact; only its dependency source and APEX setup live here.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts/media-tools/desktop-lock.json'), 'utf8'))
const env = { ...process.env, npm_config_registry: lock.npm.registry,
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  PUPPETEER_SKIP_DOWNLOAD: 'true' }
const args = process.argv.slice(2)
const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const upstream = path.join(root, '.runtime/hypit/node_modules/@hypit/hypit/bin/hypit.mjs')
const preparing = args[0] === 'apex-prepare'
const command = preparing ? python : process.execPath
const parameters = preparing ? ['-m', 'apex_overlay.media_tools', 'prepare-hypit', ...args.slice(1)] : [upstream, ...args]
const child = spawn(command, parameters, { env: { ...env,
  PYTHONPATH: [root, env.PYTHONPATH].filter(Boolean).join(path.delimiter) }, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(`Hypit could not start: ${error.message}`); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
