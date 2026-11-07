// Guard for the OpenFilm patch 0002-host-chromium: APEX runs OpenFilm with the agent browser's Chromium
// (OPENFILM_CHROMIUM), never with a browser OpenFilm downloads from Playwright's CDN.
//   OPENFILM_PACKAGE=<openfilm package, playwright-core beside it> node --test chromium.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const pkg = process.env.OPENFILM_PACKAGE
if (!pkg) throw new Error('Set OPENFILM_PACKAGE to the openfilm package folder (playwright-core beside it).')
const scratch = mkdtempSync(join(tmpdir(), 'apex-openfilm-chromium-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const noBrowsers = join(scratch, 'no-browsers')
mkdirSync(noBrowsers)
const missing = join(scratch, 'no-such-chromium', process.platform === 'win32' ? 'chrome.exe' : 'chrome')
/* Playwright reads where its browsers are once, when it loads */
process.env.PLAYWRIGHT_BROWSERS_PATH = noBrowsers
const { launch } = await import(pathToFileURL(join(resolve(pkg), 'src/host.mjs')).href)

/** launch() under `env`, which fails here (no browser): its message. */
async function launchError(env) {
  const before = { ...process.env }
  Object.assign(process.env, env)
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
  try {
    const browser = await launch()
    await browser.close()
    return null
  } catch (error) {
    return String(error?.message ?? error)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]
    Object.assign(process.env, before)
  }
}

test('every headless launch starts the Chromium OPENFILM_CHROMIUM names', async () => {
  const message = await launchError({ OPENFILM_CHROMIUM: missing })
  assert.ok(message, 'launch() did not fail on a missing browser')
  assert.ok(message.includes(missing), `launch() did not start OPENFILM_CHROMIUM: ${message}`)
})

test("without OPENFILM_CHROMIUM a launch looks for Playwright's own browser, as before", async () => {
  const message = await launchError({ OPENFILM_CHROMIUM: undefined })
  assert.ok(message?.includes(noBrowsers), `launch() did not look in PLAYWRIGHT_BROWSERS_PATH: ${message}`)
})

test(
  'a missing OPENFILM_CHROMIUM fails `openfilm render` and nothing is downloaded in its place',
  { skip: process.platform === 'win32' },
  () => {
    const project = join(scratch, 'project')
    mkdirSync(join(project, '.film'), { recursive: true })
    writeFileSync(join(project, '.film', 'opened'), '')
    writeFileSync(join(project, 'a.html'), '<!doctype html><p>a</p>')
    writeFileSync(
      join(project, 'film.html'),
      '<!doctype html>\n<html>\n<body>\n<section>\n  <iframe id="a" src="a.html" at="0"></iframe>\n</section>\n</body>\n</html>\n'
    )
    /* render first asks for ffmpeg: stand-ins that answer -version */
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    for (const name of ['ffmpeg', 'ffprobe']) {
      writeFileSync(join(bin, name), '#!/bin/sh\necho "stand-in"\n')
      chmodSync(join(bin, name), 0o755)
    }
    const run = spawnSync(
      process.execPath,
      [join(resolve(pkg), 'bin/openfilm.mjs'), 'render', '0-1', '--out', join(scratch, 'out.mp4')],
      {
        cwd: project,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          OPENFILM_CHROMIUM: missing,
          OPENFILM_HOME: join(scratch, 'home'),
          OPENFILM_NO_BROWSER: '1',
          OPENFILM_NO_UPDATE_CHECK: '1',
          PLAYWRIGHT_BROWSERS_PATH: noBrowsers,
          /* a download, if one were tried, fails at once instead of fetching 100 MB */
          PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:9'
        }
      }
    )
    const said = `${run.stdout}\n${run.stderr}`
    assert.notEqual(run.status, 0, said)
    assert.ok(said.includes(missing), `the failure does not name OPENFILM_CHROMIUM: ${said}`)
    assert.doesNotMatch(said, /downloading the browser/)
    assert.deepEqual(readdirSync(noBrowsers), [])
  }
)
