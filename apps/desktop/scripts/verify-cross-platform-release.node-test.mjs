import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFeed, verifyCrossPlatformRelease } from './verify-cross-platform-release.mjs'

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

test('the production readback passes a later release while the Intel feed stays at 0.17.63', async () => {
  // Mac x64 is no longer built, so desktop/mac-x64/ never advances past 0.17.63.
  const requested = []
  const fetchImpl = async (url, options = {}) => {
    requested.push(url)
    if (options.method === 'HEAD') return response(200, '', 123)
    const version = url.includes('/desktop/mac-x64/') ? '0.17.63' : '0.17.64'
    return response(200, `version: ${version}\npath: APEX-${version}.zip\n`)
  }

  const results = await verifyCrossPlatformRelease({ expectedVersion: '0.17.64', fetchImpl })
  assert.deepEqual(results.map(result => result.platform), ['mac-arm64', 'win-x64'])
  assert.ok(requested.some(url => url.endsWith('/desktop/mac-arm64/latest-mac.yml')))
  assert.ok(requested.some(url => url.endsWith('/desktop/win-x64/latest.yml')))
  assert.ok(!requested.some(url => url.includes('/desktop/mac-x64/')), 'the readback must not read the frozen Intel feed')
})
