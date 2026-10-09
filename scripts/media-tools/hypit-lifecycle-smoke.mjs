// Exercise the shipped CLI and native providers, not just `hypit --version`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [runtime, destination] = process.argv.slice(2)
assert.ok(runtime && destination, 'Usage: node hypit-lifecycle-smoke.mjs RUNTIME_ROOT NEW_WORKSPACE')
const root = path.resolve(runtime)
const work = path.resolve(destination)
assert.ok(!fs.existsSync(work), 'Use a new workspace; do not replace a user project')
fs.mkdirSync(work, { recursive: true })
const windows = process.platform === 'win32'
const node = path.join(root, '.runtime/node', windows ? 'node.exe' : 'bin/node')
const cli = path.join(root, 'apex_overlay/hypit_cli.mjs')
const env = { ...process.env, HERMES_HOME: path.join(work, 'home'), PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1' }
delete env.NODE_OPTIONS
const proof = { platform: process.platform, arch: process.arch, success: false,
  wrapperSha256: createHash('sha256').update(fs.readFileSync(cli)).digest('hex') }
let selected = false
function run(exe, args) {
  const result = spawnSync(exe, args, { cwd: root, env, encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024 })
  fs.appendFileSync(path.join(work, 'smoke.log'), `${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}\n`)
  assert.equal(result.status, 0, `${path.basename(exe)} failed (${result.signal || result.error || result.status}): ${result.stderr}`)
  return result.stdout
}
function hypit(args) { return run(node, [cli, ...args, '--workspace', work, '--json']) }
function json(text) { return JSON.parse(text.slice(text.indexOf('{'))) }
try {
  run(node, [cli, 'apex-prepare', '--workspace', work])
  hypit(['runtime', 'use', path.join(work, '.hypit/apex-runtime.json')])
  selected = true
  const ready = json(hypit(['runtime', 'up']))
  assert.equal(ready.ready, true)
  assert.equal(ready.programs.ready, 2)
  fs.cpSync(path.join(root, '.runtime/hypit/node_modules/@hypit/hypit/packages/media-track/preview'), path.join(work, 'render'), { recursive: true })
  const build = json(hypit(['build', path.join(work, 'render/build.svrun'), '--follow']))
  assert.equal(build.build.result.state, 'complete')
  const video = path.join(work, 'render.mp4')
  hypit(['get', build.build.id, '--output', 'final.video', '--to', video])
  const media = json(run(path.join(root, '.runtime/bin', `ffprobe${windows ? '.exe' : ''}`),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]))
  const visual = media.streams.find(s => s.codec_type === 'video')
  assert.equal(visual.codec_name, 'h264')
  assert.equal(visual.width, 720)
  assert.equal(visual.height, 1280)
  assert.equal(Number(visual.nb_frames), 150)
  assert.equal(Number(media.format.duration), 5)
  assert.equal(media.streams.find(s => s.codec_type === 'audio').codec_name, 'aac')
  Object.assign(proof, { success: true, build: build.build.id, video, media })
} catch (error) {
  proof.error = error.message
  process.exitCode = 1
} finally {
  if (selected) {
    try { hypit(['runtime', 'down']); hypit(['programs', 'down']) }
    catch (error) { proof.success = false; proof.cleanupError = error.message; process.exitCode = 1 }
  }
  fs.writeFileSync(path.join(work, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify(proof))
}
