import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const DEFAULT_FEEDS = [
  {
    platform: 'mac-arm64',
    url: 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com/desktop/mac-arm64/latest-mac.yml'
  },
  {
    platform: 'mac-x64',
    url: 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com/desktop/mac-x64/latest-mac.yml'
  },
  {
    platform: 'win-x64',
    url: 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com/desktop/win-x64/latest.yml'
  }
]

function parseFeed(text) {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1] ?? ''
  const path = /^path:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(text)?.[1]?.trim() ?? ''
  assert.ok(version, 'updater feed has no version')
  assert.ok(path, 'updater feed has no primary artifact path')
  assert.ok(!path.includes('/') && !path.includes('\\'), `unsafe updater artifact path: ${path}`)
  return { version, path }
}

async function readFeed(fetchImpl, feed) {
  const response = await fetchImpl(feed.url, { cache: 'no-store' })
  assert.equal(response.status, 200, `${feed.platform} feed returned HTTP ${response.status}`)
  const parsed = parseFeed(await response.text())
  const artifactUrl = new URL(parsed.path, feed.url).href
  const artifact = await fetchImpl(artifactUrl, { method: 'HEAD', cache: 'no-store' })
  assert.equal(artifact.status, 200, `${feed.platform} artifact returned HTTP ${artifact.status}`)
  const contentLength = Number(artifact.headers.get('content-length'))
  assert.ok(Number.isFinite(contentLength) && contentLength > 0, `${feed.platform} artifact has no positive content-length`)
  return { ...feed, ...parsed, artifactUrl, contentLength }
}

async function verifyCrossPlatformRelease({ expectedVersion, fetchImpl = fetch, feeds = DEFAULT_FEEDS }) {
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'invalid expected version')
  const results = await Promise.all(feeds.map(feed => readFeed(fetchImpl, feed)))
  for (const result of results) {
    assert.equal(result.version, expectedVersion, `${result.platform} is ${result.version}, expected ${expectedVersion}`)
  }
  assert.equal(new Set(results.map(result => result.version)).size, 1, 'production updater feeds disagree')
  return results
}

async function verifyWithRetry({ expectedVersion, attempts = 9, delayMs = 15_000, fetchImpl = fetch }) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyCrossPlatformRelease({ expectedVersion, fetchImpl })
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        console.warn(`[desktop-release] parity readback ${attempt}/${attempts} failed: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

function expectedVersionFromArgs(argv) {
  const index = argv.indexOf('--expected-version')
  return index >= 0 ? String(argv[index + 1] ?? '').trim() : ''
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expectedVersion = expectedVersionFromArgs(process.argv.slice(2))
  const results = await verifyWithRetry({ expectedVersion })
  for (const result of results) {
    console.log(`${result.platform}: ${result.version} ${result.path} (${result.contentLength} bytes)`)
  }
  console.log(`cross-platform production feeds are synchronized at ${expectedVersion}`)
}

export { DEFAULT_FEEDS, parseFeed, verifyCrossPlatformRelease, verifyWithRetry }
