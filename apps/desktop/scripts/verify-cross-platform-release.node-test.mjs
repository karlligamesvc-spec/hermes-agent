import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseArgs, parseFeed, releaseFeeds, verifyCrossPlatformRelease, verifyWithRetry } from './verify-cross-platform-release.mjs'

function response(status, body = '', contentLength = null) {
  return {
    status,
    text: async () => body,
    headers: new Headers(contentLength === null ? {} : { 'content-length': String(contentLength) })
  }
}

test('parseFeed reads the release identity and rejects nested artifact paths', () => {
  assert.deepEqual(parseFeed("version: 0.17.23\npath: APEX-0.17.23-win-x64.exe\n"), {
    version: '0.17.23',
    path: 'APEX-0.17.23-win-x64.exe'
  })
  assert.throws(() => parseFeed('version: 0.17.23\npath: ../escape.exe\n'), /unsafe updater artifact path/)
})

test('verifyCrossPlatformRelease proves every feed and artifact match one version', async () => {
  const feeds = [
    { platform: 'mac-arm64', url: 'https://release.test/mac-arm64/latest-mac.yml' },
    { platform: 'win-x64', url: 'https://release.test/win-x64/latest.yml' }
  ]
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'HEAD') return response(200, '', 123)
    const suffix = url.includes('win-x64') ? 'win-x64.exe' : 'mac-arm64.zip'
    return response(200, `version: 0.17.23\npath: APEX-0.17.23-${suffix}\n`)
  }

  const results = await verifyCrossPlatformRelease({ expectedVersion: '0.17.23', fetchImpl, feeds })
  assert.deepEqual(results.map(result => result.platform), ['mac-arm64', 'win-x64'])
  assert.ok(results.every(result => result.contentLength === 123))
})

test('verifyCrossPlatformRelease fails when one production leg is stale', async () => {
  const feeds = [
    { platform: 'mac-arm64', url: 'https://release.test/mac/latest.yml' },
    { platform: 'win-x64', url: 'https://release.test/win/latest.yml' }
  ]
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'HEAD') return response(200, '', 123)
    const version = url.includes('/win/') ? '0.17.21' : '0.17.23'
    return response(200, `version: ${version}\npath: APEX-${version}.zip\n`)
  }

  await assert.rejects(
    verifyCrossPlatformRelease({ expectedVersion: '0.17.23', fetchImpl, feeds }),
    /win-x64 is 0\.17\.21, expected 0\.17\.23/
  )
})

// Feeds by prefix; anything not listed answers with the release version.
function feedServer(versions, releaseVersion) {
  const requested = []
  const fetchImpl = async (url, options = {}) => {
    requested.push(url)
    if (options.method === 'HEAD') return response(200, '', 123)
    const version = Object.entries(versions).find(([prefix]) => url.includes(prefix))?.[1] ?? releaseVersion
    return response(200, `version: ${version}\npath: APEX-${version}.zip\n`)
  }
  return { fetchImpl, requested }
}

test('a Mac-only release reads only Mac arm64 while the Windows and Intel feeds stay where they are', async () => {
  // Without windows=true, desktop/win-x64/ stays at the last fixed version (0.17.66 in this
  // fixture) and desktop/mac-x64/ at 0.17.63.
  const held = { '/desktop/win-x64/': '0.17.66', '/desktop/mac-x64/': '0.17.63' }
  const { fetchImpl, requested } = feedServer(held, '0.17.74')

  const results = await verifyCrossPlatformRelease({ expectedVersion: '0.17.74', fetchImpl })
  assert.deepEqual(results.map(result => result.platform), ['mac-arm64'])
  assert.ok(requested.some(url => url.endsWith('/desktop/mac-arm64/latest-mac.yml')))
  for (const prefix of Object.keys(held)) {
    assert.ok(!requested.some(url => url.includes(prefix)), `a Mac-only readback must not read ${prefix}`)
  }
})

test('a release that includes Windows reads both feeds and fails while the Windows feed lags', async () => {
  const both = releaseFeeds({ includeWindows: true })
  assert.deepEqual(both.map(feed => feed.platform), ['mac-arm64', 'win-x64'])

  const synced = feedServer({ '/desktop/mac-x64/': '0.17.63' }, '0.17.73')
  const results = await verifyCrossPlatformRelease({ expectedVersion: '0.17.73', fetchImpl: synced.fetchImpl, feeds: both })
  assert.deepEqual(results.map(result => result.platform), ['mac-arm64', 'win-x64'])
  assert.ok(synced.requested.some(url => url.endsWith('/desktop/win-x64/latest.yml')))
  assert.ok(!synced.requested.some(url => url.includes('/desktop/mac-x64/')), 'the readback must not read the Intel feed')

  // The CLI path: verifyWithRetry with the feeds parseArgs chose.
  const lagging = feedServer({ '/desktop/win-x64/': '0.17.66' }, '0.17.73')
  await assert.rejects(
    verifyWithRetry({ expectedVersion: '0.17.73', attempts: 1, delayMs: 0, fetchImpl: lagging.fetchImpl, feeds: both }),
    /win-x64 is 0\.17\.66, expected 0\.17\.73/
  )
})

test('parseArgs adds the Windows feed only for --include-windows and refuses anything it does not know', () => {
  assert.deepEqual(parseArgs(['--expected-version', '0.17.74']), { expectedVersion: '0.17.74', includeWindows: false })
  assert.deepEqual(parseArgs(['--expected-version', '0.17.73', '--include-windows']), { expectedVersion: '0.17.73', includeWindows: true })
  // A misspelt flag would otherwise read back Mac only after Windows published.
  assert.throws(() => parseArgs(['--expected-version', '0.17.73', '--include-window']), /unknown argument: --include-window/)
  assert.throws(() => parseArgs(['--expected-version']), /missing value for --expected-version/)
})

// The command desktop-release.yml runs, with fetch answered locally and the retry delay skipped.
const STUB_FEEDS = `
import fs from 'node:fs'
const held = JSON.parse(process.env.FEED_HELD)
globalThis.setTimeout = resolve => { resolve(); return 0 }
globalThis.fetch = async (url, options = {}) => {
  fs.appendFileSync(process.env.FEED_REQUESTS, url + '\\n')
  const headers = new Headers({ 'content-length': '123' })
  if (options.method === 'HEAD') return { status: 200, headers, text: async () => '' }
  const version = Object.entries(held).find(([prefix]) => url.includes(prefix))?.[1] ?? process.env.FEED_RELEASE
  return { status: 200, headers, text: async () => 'version: ' + version + '\\npath: APEX-' + version + '.zip\\n' }
}
`

test('the readback command reads Windows only with --include-windows and fails while it lags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-readback-cli-'))
  const stub = path.join(dir, 'stub-feeds.mjs')
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-cross-platform-release.mjs')
  fs.writeFileSync(stub, STUB_FEEDS)
  const run = (args, held) => {
    const requests = path.join(dir, `requests-${Math.random()}`)
    fs.writeFileSync(requests, '')
    const result = spawnSync(process.execPath, ['--import', stub, script, '--expected-version', '0.17.73', ...args], {
      encoding: 'utf8',
      env: { ...process.env, FEED_HELD: JSON.stringify(held), FEED_RELEASE: '0.17.73', FEED_REQUESTS: requests }
    })
    return { ...result, requested: fs.readFileSync(requests, 'utf8') }
  }
  try {
    const lagging = { '/desktop/win-x64/': '0.17.66', '/desktop/mac-x64/': '0.17.63' }
    const macOnly = run([], lagging)
    assert.equal(macOnly.status, 0, macOnly.stderr)
    assert.doesNotMatch(macOnly.requested, /\/desktop\/win-x64\//)

    const withWindows = run(['--include-windows'], { '/desktop/mac-x64/': '0.17.63' })
    assert.equal(withWindows.status, 0, withWindows.stderr)
    assert.match(withWindows.stdout, /^win-x64: 0\.17\.73 /m)
    assert.match(withWindows.requested, /\/desktop\/win-x64\/latest\.yml/)

    const windowsLagging = run(['--include-windows'], lagging)
    assert.notEqual(windowsLagging.status, 0)
    assert.match(windowsLagging.stderr, /win-x64 is 0\.17\.66, expected 0\.17\.73/)

    for (const result of [macOnly, withWindows, windowsLagging]) {
      assert.doesNotMatch(result.requested, /\/desktop\/mac-x64\//, 'the readback must not read the Intel feed')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
