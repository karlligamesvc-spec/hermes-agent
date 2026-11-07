import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const FEED_BASE = 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com/desktop'

// The feeds a release advances, one per platform desktop-release.yml builds.
// Every release builds Mac arm64. Windows x64 is built only by a run dispatched
// with windows=true (a fixed version), which passes --include-windows here; any
// other release leaves desktop/win-x64/ at the last fixed version, so reading it
// would fail that release. desktop/mac-x64/ (Intel, stopped after 0.17.63) is
// never read.
const MAC_FEEDS = [
  { platform: 'mac-arm64', url: `${FEED_BASE}/mac-arm64/latest-mac.yml` }
]
const WINDOWS_FEED = { platform: 'win-x64', url: `${FEED_BASE}/win-x64/latest.yml` }

function releaseFeeds({ includeWindows = false } = {}) {
  return includeWindows ? [...MAC_FEEDS, WINDOWS_FEED] : [...MAC_FEEDS]
}

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

async function verifyCrossPlatformRelease({ expectedVersion, fetchImpl = fetch, feeds = releaseFeeds() }) {
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'invalid expected version')
  const results = await Promise.all(feeds.map(feed => readFeed(fetchImpl, feed)))
  for (const result of results) {
    assert.equal(result.version, expectedVersion, `${result.platform} is ${result.version}, expected ${expectedVersion}`)
  }
  assert.equal(new Set(results.map(result => result.version)).size, 1, 'production updater feeds disagree')
  return results
}

async function verifyWithRetry({ expectedVersion, attempts = 9, delayMs = 15_000, fetchImpl = fetch, feeds = releaseFeeds() }) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyCrossPlatformRelease({ expectedVersion, fetchImpl, feeds })
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

// Strict: a misspelt --include-windows must fail the readback, not quietly skip the
// Windows feed of a release that published it.
function parseArgs(argv) {
  const options = { expectedVersion: '', includeWindows: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--expected-version') {
      if (index + 1 >= argv.length) throw new Error('missing value for --expected-version')
      options.expectedVersion = String(argv[++index]).trim()
    } else if (argv[index] === '--include-windows') {
      options.includeWindows = true
    } else {
      throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { expectedVersion, includeWindows } = parseArgs(process.argv.slice(2))
  const results = await verifyWithRetry({ expectedVersion, feeds: releaseFeeds({ includeWindows }) })
  for (const result of results) {
    console.log(`${result.platform}: ${result.version} ${result.path} (${result.contentLength} bytes)`)
  }
  console.log(`production updater feeds (${results.map(result => result.platform).join(', ')}) are at ${expectedVersion}`)
}

export { MAC_FEEDS, WINDOWS_FEED, parseArgs, parseFeed, releaseFeeds, verifyCrossPlatformRelease, verifyWithRetry }
