// Guard for the OpenFilm patch 0003-hosted-studio: in APEX, Desktop runs Studio (OPENFILM_HOSTED=1 for the agent's
// `openfilm`), so the CLI never starts, restarts or replaces one, which nothing would stop when APEX quits.
//   OPENFILM_PACKAGE=<openfilm package, playwright-core beside it> node --test hosted-studio.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const pkg = process.env.OPENFILM_PACKAGE
if (!pkg) throw new Error('Set OPENFILM_PACKAGE to the openfilm package folder (playwright-core beside it).')
const scratch = mkdtempSync(join(tmpdir(), 'apex-openfilm-hosted-'))
const home = join(scratch, 'home')
mkdirSync(home)
Object.assign(process.env, { OPENFILM_HOME: home, OPENFILM_NO_BROWSER: '1', OPENFILM_NO_UPDATE_CHECK: '1', OPENFILM_HOSTED: '1' })
const runFile = join(home, 'run.json')

/** Studios this test saw that it did not start in this process (the guard failing means the CLI started one). */
const strays = []
/** Note the Studio run.json names now, if it is not this process's own (it writes run.json once it listens). */
async function noteStray() {
  for (let i = 0; i < 20 && !existsSync(runFile); i++) await new Promise(done => setTimeout(done, 200))
  if (!existsSync(runFile)) return
  const run = JSON.parse(readFileSync(runFile, 'utf8'))
  if (run.pid !== process.pid) strays.push(run)
}
/** Each noted Studio is asked to quit, then its process group (started detached: supervisor, worker) is ended. */
async function endStrays() {
  for (const run of strays) {
    await fetch(`${run.origin}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': run.key }, body: '{}', signal: AbortSignal.timeout(3000) }).catch(() => null)
    for (const target of [run.supervisor && -run.supervisor, run.supervisor, run.pid]) {
      try {
        if (target) process.kill(target, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
}
after(async () => {
  await endStrays()
  rmSync(scratch, { recursive: true, force: true })
})

test('with no Studio running, `openfilm look` starts none and carries on without it', { skip: process.platform === 'win32' }, async () => {
  const project = join(scratch, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'a.html'), '<!doctype html><p>a</p>')
  writeFileSync(join(project, 'film.html'), '<!doctype html>\n<html>\n<body>\n<section>\n  <iframe id="a" src="a.html" at="0"></iframe>\n</section>\n</body>\n</html>\n')
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  for (const name of ['ffmpeg', 'ffprobe']) {
    writeFileSync(join(bin, name), '#!/bin/sh\necho "stand-in"\n')
    chmodSync(join(bin, name), 0o755)
  }
  const ran = spawnSync(process.execPath, [join(resolve(pkg), 'bin/openfilm.mjs'), 'look'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OPENFILM_CHROMIUM: join(scratch, 'no-browser'), PLAYWRIGHT_BROWSERS_PATH: join(scratch, 'no-browsers'), PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:9' }
  })
  const said = `${ran.stdout}\n${ran.stderr}`
  // (a Studio that was started writes run.json once it listens; give it the time it takes)
  await new Promise(done => setTimeout(done, 3000))
  await noteStray()
  assert.equal(existsSync(runFile), false, `a Studio was started: ${said}`)
  assert.equal(existsSync(join(home, 'logs', 'studio.log')), false, 'a Studio was started (its log is there)')
  assert.match(said, /carrying on without Studio/)
})

test('the host’s Studio is the one used, and never replaced, even when asked for a fresh one', async () => {
  const { startStudio } = await import(pathToFileURL(join(resolve(pkg), 'studio/server/server.mjs')).href)
  const { ensureStudio } = await import(pathToFileURL(join(resolve(pkg), 'studio/client.mjs')).href)
  const host = await startStudio({ port: 0, advertise: true, openBrowser: () => {} })
  try {
    for (const fresh of [false, true]) {
      const found = await ensureStudio(() => {}, { fresh })
      await noteStray()
      assert.equal(found.origin, host.origin)
    }
    const health = await (await fetch(`${host.origin}/api/health`)).json()
    assert.equal(health.product, 'openfilm-studio', 'the host’s Studio was asked to quit')
  } finally {
    await host.close()
  }
})
