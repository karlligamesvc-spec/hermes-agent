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
const installedVersion = JSON.parse(fs.readFileSync(path.join(root, '.runtime/hypit/node_modules/@hypit/hypit/package.json'))).version
const modern = installedVersion.startsWith('0.3.')
const env = { ...process.env, HERMES_HOME: path.join(work, 'home'), PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1' }
delete env.NODE_OPTIONS
const proof = { platform: process.platform, arch: process.arch, version: installedVersion, success: false,
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
  const profile = run(node, [cli, 'apex-prepare', '--workspace', work]).trim()
  hypit(['runtime', 'use', profile])
  selected = true
  const ready = json(hypit(['runtime', 'up']))
  assert.equal(ready.ready, true)
  assert.equal(ready.programs.ready, 2)
  if (modern) {
    fs.cpSync(path.join(root, 'scripts/media-tools/fixtures/hypit-031'), path.join(work, 'render'), { recursive: true })
    run(path.join(root, '.runtime/bin', `ffmpeg${windows ? '.exe' : ''}`),
      ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i',
        'sine=frequency=440:sample_rate=48000', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(work, 'render/input.mp4')])
  } else {
    fs.cpSync(path.join(root, '.runtime/hypit/node_modules/@hypit/hypit/packages/media-track/preview'), path.join(work, 'render'), { recursive: true })
  }
  hypit(['check', path.join(work, 'render/build.svrun')])
  hypit(['plan', path.join(work, 'render/build.svrun')])
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
  const ffmpeg = path.join(root, '.runtime/bin', `ffmpeg${windows ? '.exe' : ''}`)
  run(ffmpeg, ['-v', 'error', '-i', video, '-f', 'null', '-'])
  run(ffmpeg, ['-v', 'error', '-ss', '2.5', '-i', video, '-frames:v', '1', path.join(work, 'frame.png')])
  const page = path.join(work, 'capture.html')
  fs.writeFileSync(page, '<!doctype html><h1>APEX Hypit lifecycle</h1>')
  const capture = json(hypit(['capture', 'screenshot', page, '--to', path.join(work, 'capture.png'), '--viewport', '1280x720']))
  assert.equal(capture.outputs[0].width, 1280)
  assert.equal(capture.outputs[0].height, 720)
  fs.writeFileSync(path.join(work, 'interaction.mjs'), `
export default async ({page,screenshot,args}) => {
  if (args.join('|') !== '--workspace|script-only') throw new Error('script arguments changed');
  await page.setContent('<button>start</button>');
  await page.evaluate(() => { document.querySelector('button').onclick = function () { this.textContent = 'clicked'; }; });
  await page.click('button');
  if (await page.$eval('button', b => b.textContent) !== 'clicked') throw new Error('click failed');
  await screenshot({path: ${JSON.stringify(path.join(work, 'interaction.png'))}});
}`)
  const interaction = json(run(node, [cli, 'capture', 'run', 'interaction.mjs', '--workspace', work,
    '--json', '--', '--workspace', 'script-only']))
  assert.equal(interaction.outputs.length, 1)
  if (modern) {
    const pcm = spawnSync(ffmpeg, ['-v','error','-i',video,'-vn','-ac','1','-ar','48000','-f','s16le','-'],
      {env,timeout:60000,maxBuffer:4*1024*1024})
    assert.equal(pcm.status,0)
    assert.ok(pcm.stdout.length >= 480000)
    let squares = 0
    for (let i=0;i<pcm.stdout.length;i+=2) squares += pcm.stdout.readInt16LE(i) ** 2
    proof.audioRms = Math.sqrt(squares / (pcm.stdout.length/2))
    assert.ok(proof.audioRms > 100, 'rendered audio must not be silent')
  }
  Object.assign(proof, { success: true, build: build.build.id, video, media, capture, interaction,
    videoSha256:createHash('sha256').update(fs.readFileSync(video)).digest('hex') })
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
