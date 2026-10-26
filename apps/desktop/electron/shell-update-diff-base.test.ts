import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { blake2b as nobleBlake2b } from '@noble/hashes/blake2.js'
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js'
import { configureRequestOptions, configureRequestUrl } from 'builder-util-runtime'
import { NodeHttpExecutor } from 'builder-util/out/nodeHttpExecutor.js'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater.js'
import { afterEach, describe, test } from 'vitest'

process.env.APEXNODES_TELEMETRY = 'off'

const require = createRequire(import.meta.url)

import { artifactName, blake2b, blockMapDescribesFile, parseBlockMap, prepareDifferentialBase } from './shell-update-diff-base'
import { createShellUpdater } from './shell-updater'

// ---------------------------------------------------------------------------
// Fixtures: three "releases" of an incompressible 3 MB package, each a few
// small edits away from the one before (the shape of a minor version), with
// blockmaps from electron-builder's own builder.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {await cleanups.pop()!()}
})

function noise(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length)

  for (let at = 0, n = 0; at < length; n++) {at += createHash('sha256').update(`${seed}:${n}`).digest().copy(out, at)}

  return out
}

function edit(base: Buffer, edits: Array<[at: number, remove: number, insert: Buffer]>): Buffer {
  let out = base

  for (const [at, remove, insert] of edits) {out = Buffer.concat([out.subarray(0, at), insert, out.subarray(at + remove)])}

  return out
}

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hc1058-${label}-`))

  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

  return dir
}

const v1 = noise('v1', 3 * MB)
const v2 = edit(v1, [[400_000, 2_000, noise('e1', 2_000)], [1_500_000, 0, noise('e2', 5_000)], [2_500_000, 1_000, Buffer.alloc(0)]])
const v3 = edit(v2, [[700_000, 0, noise('e3', 3_000)], [2_000_000, 4_000, noise('e4', 4_000)]])
const RELEASES: Record<string, Buffer> = { '1.0.1': v1, '1.0.2': v2, '1.0.3': v3 }

const sha512 = (data: Buffer) => createHash('sha512').update(data).digest('base64')

// Writes every release + its blockmap into `dir` under the shipped artifact names.
async function writeFeed(dir: string, platform: 'darwin' | 'win32', latest = '1.0.3') {
  fs.mkdirSync(dir, { recursive: true })

  for (const [version, data] of Object.entries(RELEASES)) {
    const name = artifactName(version, platform, platform === 'darwin' ? 'arm64' : 'x64')

    fs.writeFileSync(path.join(dir, name), data)
    await buildBlockMap(path.join(dir, name), 'gzip', path.join(dir, `${name}.blockmap`))
  }

  const name = artifactName(latest, platform, platform === 'darwin' ? 'arm64' : 'x64')
  const data = RELEASES[latest]

  fs.writeFileSync(path.join(dir, platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'), [
    `version: ${latest}`, 'files:', `  - url: ${name}`, `    sha512: ${sha512(data)}`, `    size: ${data.length}`,
    `path: ${name}`, `sha512: ${sha512(data)}`, "releaseDate: '2026-10-26T00:00:00.000Z'", ''
  ].join('\n'))
}

function blockMapOf(dir: string, version: string, platform: 'darwin' | 'win32'): Buffer {
  return fs.readFileSync(path.join(dir, `${artifactName(version, platform, platform === 'darwin' ? 'arm64' : 'x64')}.blockmap`))
}

// ---------------------------------------------------------------------------
// blake2b
// ---------------------------------------------------------------------------

describe('blake2b', () => {
  test('matches the RFC 7693 Appendix A vector and the 18-byte digest electron-builder stores', () => {
    assert.equal(blake2b(Buffer.from('abc'), 64).toString('hex'),
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
      '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923')
    // Python: base64(hashlib.blake2b(b'a', digest_size=18).digest())
    assert.equal(blake2b(Buffer.from('a'), 18).toString('base64'), 'Y+WF5whcXqMEScS30aCwW5KS')
  })

  test.each([0, 1, 127, 128, 129, 255, 256, 257, 1000, 16_384, 32_768])('agrees with @noble/hashes for %i input bytes', length => {
    const data = noise(`len${length}`, length)

    for (const dkLen of [1, 18, 32, 64]) {
      assert.equal(blake2b(data, dkLen).toString('hex'), Buffer.from(nobleBlake2b(data, { dkLen })).toString('hex'), `dkLen ${dkLen}`)
    }
  })
})

// ---------------------------------------------------------------------------
// blockmap ↔ file proof
// ---------------------------------------------------------------------------

describe('blockMapDescribesFile', () => {
  test('accepts the blockmap built for the file and rejects a neighbouring release', async () => {
    const dir = tempDir('describe')

    await writeFeed(dir, 'win32')
    const file = path.join(dir, artifactName('1.0.2', 'win32', 'x64'))

    assert.equal(await blockMapDescribesFile(file, parseBlockMap(blockMapOf(dir, '1.0.2', 'win32'))!), true)
    assert.equal(await blockMapDescribesFile(file, parseBlockMap(blockMapOf(dir, '1.0.1', 'win32'))!), false)
    assert.equal(await blockMapDescribesFile(file, parseBlockMap(blockMapOf(dir, '1.0.3', 'win32'))!), false)
  })

  test('rejects a file with extra trailing bytes even though every chunk it has matches', async () => {
    const dir = tempDir('describe-length')

    await writeFeed(dir, 'win32')
    const file = path.join(dir, 'longer.bin')

    fs.writeFileSync(file, Buffer.concat([v2, Buffer.from('trailing')]))
    assert.equal(await blockMapDescribesFile(file, parseBlockMap(blockMapOf(dir, '1.0.2', 'win32'))!), false)
  })

  test('rejects a same-length file whose first chunk differs', async () => {
    const dir = tempDir('describe-content')

    await writeFeed(dir, 'win32')
    const file = path.join(dir, 'flipped.bin')
    const flipped = Buffer.from(v2)

    flipped[0] ^= 0xff
    fs.writeFileSync(file, flipped)
    assert.equal(await blockMapDescribesFile(file, parseBlockMap(blockMapOf(dir, '1.0.2', 'win32'))!), false)
  })

  test('ignores a blockmap that is not gzip JSON with one file entry', () => {
    assert.equal(parseBlockMap(Buffer.from('nope')), null)
    assert.equal(parseBlockMap(zlib.gzipSync(JSON.stringify({ version: '2', files: [] }))), null)
  })
})

// ---------------------------------------------------------------------------
// prepareDifferentialBase on the cache layout electron-updater 6.8.9 uses
// ---------------------------------------------------------------------------

function cacheWith({ platform, oldFile, current, pending }: { platform: 'darwin' | 'win32'; oldFile?: Buffer; current?: Buffer; pending?: string }) {
  const cacheDir = tempDir(`cache-${platform}`)

  if (oldFile) {fs.writeFileSync(path.join(cacheDir, platform === 'darwin' ? 'update.zip' : 'installer.exe'), oldFile)}

  if (current) {fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), current)}

  if (pending) {
    fs.mkdirSync(path.join(cacheDir, 'pending'))
    fs.writeFileSync(path.join(cacheDir, 'pending', 'update-info.json'), JSON.stringify({ fileName: pending, sha512: 'x', isAdminRightsRequired: false }))
  }

  return cacheDir
}

function feedFetcher(feedDir: string) {
  const fetched: string[] = []

  return {
    fetched,
    fetchBuffer: async (url: string) => {
      fetched.push(url)
      const file = path.join(feedDir, path.basename(new URL(url).pathname))

      if (!fs.existsSync(file)) {throw new Error('HTTP 404')}

      return fs.readFileSync(file)
    }
  }
}

describe('prepareDifferentialBase', () => {
  const FEED = 'https://feed.test/desktop/mac-arm64'

  test('macOS: no update.zip leaves the updater to its own full download', async () => {
    const feed = tempDir('feed')

    await writeFeed(feed, 'darwin')
    const { fetchBuffer, fetched } = feedFetcher(feed)
    const cacheDir = cacheWith({ platform: 'darwin' })
    const result = await prepareDifferentialBase({ cacheDir, platform: 'darwin', arch: 'arm64', appVersion: '1.0.1', feedUrl: FEED, fetchBuffer })

    assert.deepEqual(result, { outcome: { base: 'none' }, disableDifferential: false })
    assert.deepEqual(fetched, [])
  })

  test('macOS: a cached blockmap that describes update.zip is kept without any fetch', async () => {
    const feed = tempDir('feed')

    await writeFeed(feed, 'darwin')
    const { fetchBuffer, fetched } = feedFetcher(feed)
    const cacheDir = cacheWith({ platform: 'darwin', oldFile: v2, current: blockMapOf(feed, '1.0.2', 'darwin') })
    const result = await prepareDifferentialBase({ cacheDir, platform: 'darwin', arch: 'arm64', appVersion: '1.0.1', feedUrl: FEED, fetchBuffer })

    assert.deepEqual(result, { outcome: { base: 'cached' }, disableDifferential: false })
    assert.deepEqual(fetched, [])
  })

  // The 2026-10-23 sequence: 0.17.61 downloaded in full and never installed, so
  // update.zip held 0.17.61, no current.blockmap existed, and the updater took
  // the RUNNING version's (0.17.60) blockmap.
  test.each([
    ['no cached blockmap', undefined],
    ['a cached blockmap of the running version', '1.0.1']
  ])('macOS: downloaded-not-installed update.zip with %s gets the downloaded release\'s blockmap', async (_label, cachedVersion) => {
    const feed = tempDir('feed')

    await writeFeed(feed, 'darwin')
    const { fetchBuffer, fetched } = feedFetcher(feed)

    const cacheDir = cacheWith({
      platform: 'darwin',
      oldFile: v2,
      current: cachedVersion ? blockMapOf(feed, cachedVersion, 'darwin') : undefined,
      pending: 'APEX-1.0.2-mac-arm64.zip'
    })

    const result = await prepareDifferentialBase({ cacheDir, platform: 'darwin', arch: 'arm64', appVersion: '1.0.1', feedUrl: FEED, fetchBuffer })

    assert.deepEqual(result, { outcome: { base: 'repaired', version: '1.0.2' }, disableDifferential: false })
    assert.deepEqual(fetched, [`${FEED}/APEX-1.0.2-mac-arm64.zip.blockmap`])
    assert.deepEqual(parseBlockMap(fs.readFileSync(path.join(cacheDir, 'current.blockmap'))),
      parseBlockMap(blockMapOf(feed, '1.0.2', 'darwin')))
  })

  test('macOS: with no provable base the stale update.zip and blockmap are removed, differential stays on', async () => {
    const feed = tempDir('feed')

    await writeFeed(feed, 'darwin')
    const { fetchBuffer, fetched } = feedFetcher(feed)
    const cacheDir = cacheWith({ platform: 'darwin', oldFile: noise('junk', 3 * MB), current: blockMapOf(feed, '1.0.1', 'darwin'), pending: 'APEX-1.0.2-mac-arm64.zip' })
    const result = await prepareDifferentialBase({ cacheDir, platform: 'darwin', arch: 'arm64', appVersion: '1.0.1', feedUrl: FEED, fetchBuffer })

    assert.deepEqual(result, {
      outcome: { base: 'dropped', tried: ['APEX-1.0.2-mac-arm64.zip', 'APEX-1.0.1-mac-arm64.zip'] },
      disableDifferential: false
    })
    assert.equal(fetched.length, 2)
    // electron-updater refreshes update.zip only while differential is enabled,
    // so the zip goes instead of the flag being set.
    assert.equal(fs.existsSync(path.join(cacheDir, 'update.zip')), false)
    assert.equal(fs.existsSync(path.join(cacheDir, 'current.blockmap')), false)
  })

  test('Windows: a blockmap of a downloaded-but-not-installed update is replaced by the installed version\'s', async () => {
    const feed = tempDir('feed')

    await writeFeed(feed, 'win32')
    const { fetchBuffer, fetched } = feedFetcher(feed)
    // installer.exe is written by the NSIS installer that last ran (1.0.1); the
    // 1.0.2 download waits in pending (hc-1030 busy deferral) with its blockmap.
    const cacheDir = cacheWith({ platform: 'win32', oldFile: v1, current: blockMapOf(feed, '1.0.2', 'win32'), pending: 'APEX-1.0.2-win-x64.exe' })
    const result = await prepareDifferentialBase({ cacheDir, platform: 'win32', arch: 'x64', appVersion: '1.0.1', feedUrl: 'https://feed.test/desktop/win-x64', fetchBuffer })

    assert.deepEqual(result, { outcome: { base: 'repaired', version: '1.0.1' }, disableDifferential: false })
    assert.deepEqual(fetched, ['https://feed.test/desktop/win-x64/APEX-1.0.1-win-x64.exe.blockmap'])
  })

  test('Windows: with no provable base the blockmap goes, the installer stays and this round skips the differential', async () => {
    const feed = tempDir('feed')

    await writeFeed(feed, 'win32')
    const { fetchBuffer } = feedFetcher(feed)
    const cacheDir = cacheWith({ platform: 'win32', oldFile: noise('msi-era', 2 * MB), current: blockMapOf(feed, '1.0.2', 'win32') })
    const result = await prepareDifferentialBase({ cacheDir, platform: 'win32', arch: 'x64', appVersion: '1.0.1', feedUrl: 'https://feed.test/desktop/win-x64', fetchBuffer })

    assert.deepEqual(result, { outcome: { base: 'dropped', tried: ['APEX-1.0.1-win-x64.exe'] }, disableDifferential: true })
    assert.equal(fs.existsSync(path.join(cacheDir, 'installer.exe')), true)
    assert.equal(fs.existsSync(path.join(cacheDir, 'current.blockmap')), false)
  })

  test('an unreachable blockmap counts as unproven, never as a match', async () => {
    const cacheDir = cacheWith({ platform: 'win32', oldFile: v1 })
    const lines: string[] = []

    const result = await prepareDifferentialBase({
      cacheDir, platform: 'win32', arch: 'x64', appVersion: '1.0.1', feedUrl: 'https://feed.test/desktop/win-x64',
      fetchBuffer: async () => {throw new Error('getaddrinfo ENOTFOUND')}, log: line => lines.push(line)
    })

    assert.equal(result.outcome.base, 'dropped')
    assert.equal(result.disableDifferential, true)
    assert.match(lines.join('\n'), /cannot fetch APEX-1\.0\.1-win-x64\.exe\.blockmap: getaddrinfo ENOTFOUND/)
  })

  test('platforms without a shell feed are left alone', async () => {
    const cacheDir = tempDir('linux')
    const result = await prepareDifferentialBase({ cacheDir, platform: 'linux', arch: 'x64', appVersion: '1.0.1', feedUrl: 'x', fetchBuffer: async () => Buffer.alloc(0) })

    assert.deepEqual(result, { outcome: { base: 'none' }, disableDifferential: false })
  })
})

// ---------------------------------------------------------------------------
// End to end through electron-updater 6.8.9's NsisUpdater + the shell updater,
// against a loopback feed that serves single HTTP ranges like COS.
// ---------------------------------------------------------------------------

async function serveFeed(root: string) {
  const served = new Map<string, number>()

  const server = http.createServer((req, res) => {
    const requested = path.basename(new URL(req.url || '/', 'http://feed').pathname)
    // The provider names its channel file after the host OS (latest-mac.yml on
    // a Mac test host); the feed has one latest.yml.
    const name = /^latest(-mac|-linux[\w-]*)?\.yml$/.test(requested) ? 'latest.yml' : requested
    const file = path.join(root, name)

    if (!fs.existsSync(file)) {res.writeHead(404); res.end();

 return}

    const data = fs.readFileSync(file)
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''))
    const body = range ? data.subarray(Number(range[1]), Number(range[2]) + 1) : data

    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': body.length,
      ...(range ? { 'Content-Range': `bytes ${range[1]}-${range[2]}/${data.length}` } : {})
    })
    res.end(body)
    served.set(name, (served.get(name) || 0) + body.length)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))

  return { base: `http://127.0.0.1:${(server.address() as any).port}/desktop`, served }
}

// NodeHttpExecutor without proxy agents, plus the full-file download that
// electron-updater's ElectronHttpExecutor provides (same body, Node transport).
class LoopbackExecutor extends NodeHttpExecutor {
  createRequest(options: any, callback: any) {
    return http.request(options, callback)
  }

  download(url: URL, destination: string, options: any): Promise<string> {
    return options.cancellationToken.createPromise((resolve: any, reject: any, onCancel: any) => {
      const requestOptions: any = { headers: options.headers || undefined, redirect: 'manual' }

      configureRequestUrl(url, requestOptions)
      configureRequestOptions(requestOptions)
      ;(this as any).doDownload(requestOptions, {
        destination, options, onCancel, responseHandler: null,
        callback: (error: any) => (error == null ? resolve(destination) : reject(error))
      }, 0)
    })
  }
}

function fakeIpcMain() {
  return { handle: () => {} }
}

async function runWindowsUpdate({ installed, cachedBlockMap, withCheck }: { installed: Buffer; cachedBlockMap?: string; withCheck: boolean }) {
  const feedDir = tempDir('nsis-feed')

  await writeFeed(path.join(feedDir, 'win-x64'), 'win32')
  const { base, served } = await serveFeed(path.join(feedDir, 'win-x64'))
  const home = tempDir('nsis-home')
  const configPath = path.join(home, 'app-update.yml')

  fs.writeFileSync(configPath, 'provider: generic\nurl: http://unused.invalid\nupdaterCacheDirName: apex-test-updater\n')
  const cacheDir = path.join(home, 'cache', 'apex-test-updater')

  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'installer.exe'), installed)

  if (cachedBlockMap) {fs.copyFileSync(path.join(feedDir, 'win-x64', `${artifactName(cachedBlockMap, 'win32', 'x64')}.blockmap`), path.join(cacheDir, 'current.blockmap'))}

  const updater: any = new NsisUpdater(null, {
    version: '1.0.1', name: 'APEX', isPackaged: true, appUpdateConfigPath: configPath, userDataPath: home,
    baseCachePath: path.join(home, 'cache'), whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {}
  } as any)

  updater.httpExecutor = new LoopbackExecutor()
  updater.disableWebInstaller = true
  const lines: string[] = []

  const shell = createShellUpdater({
    autoUpdater: updater,
    ipcMain: fakeIpcMain(),
    isPackaged: true,
    feedBase: base,
    platform: 'win32',
    arch: 'x64',
    appVersion: '1.0.1',
    initialDelayMs: 3_600_000,
    recheckIntervalMs: 3_600_000,
    log: (line: string) => lines.push(line),
    sendTelemetry: () => {},
    ...(withCheck ? {} : { prepareDiffBase: async () => ({ outcome: { base: 'none' }, disableDifferential: false }) })
  })

  cleanups.push(() => shell.dispose())

  const downloaded = new Promise<any>((resolve, reject) => {
    updater.once('update-downloaded', resolve)
    updater.once('error', reject)
  })

  await shell.checkNow()
  const event = await downloaded
  const file = fs.readFileSync(event.downloadedFile)

  return { lines: lines.join('\n'), servedPackage: served.get('APEX-1.0.3-win-x64.exe') || 0, file, cacheDir }
}

describe('shell update end to end (NsisUpdater, loopback feed)', () => {
  test('control: a downloaded-but-not-installed blockmap makes the differential fail its sha512 and download twice', async () => {
    const run = await runWindowsUpdate({ installed: v1, cachedBlockMap: '1.0.2', withCheck: false })

    assert.match(run.lines, /Cannot download differentially, fallback to full download: Error: sha512 checksum mismatch/)
    assert.ok(run.servedPackage > v3.length, `served ${run.servedPackage} > full ${v3.length}`)
    assert.equal(sha512(run.file), sha512(v3))
  })

  test('with the base check the same cache downloads only the changed blocks', async () => {
    const run = await runWindowsUpdate({ installed: v1, cachedBlockMap: '1.0.2', withCheck: true })

    assert.match(run.lines, /diff base: installer\.exe is 1\.0\.1; cached its blockmap/)
    assert.doesNotMatch(run.lines, /Cannot download differentially/)
    assert.ok(run.servedPackage < v3.length / 10, `served ${run.servedPackage} of ${v3.length}`)
    assert.equal(sha512(run.file), sha512(v3))
  })

  test('a base that passes the sampled proof but differs elsewhere still falls back to a correct full download', async () => {
    // Corrupt one chunk the sample does not read: the proof accepts the pair,
    // the rebuilt file fails sha512, and electron-updater downloads in full.
    const feedDir = tempDir('find-unsampled')

    await writeFeed(feedDir, 'win32')
    const map = parseBlockMap(blockMapOf(feedDir, '1.0.1', 'win32'))!
    const { sizes } = map.files[0]
    const probe = path.join(feedDir, 'probe.bin')
    let corrupted: Buffer | null = null

    for (let index = Math.floor(sizes.length / 2), start = sizes.slice(0, index).reduce((a, b) => a + b, 0); index < sizes.length; start += sizes[index], index++) {
      const candidate = Buffer.from(v1)

      candidate[start + 7] ^= 0xff
      fs.writeFileSync(probe, candidate)

      if (await blockMapDescribesFile(probe, map)) {corrupted = candidate;

 break}
    }

    assert.ok(corrupted, 'an unsampled chunk exists')
    const run = await runWindowsUpdate({ installed: corrupted!, withCheck: true })

    assert.match(run.lines, /Cannot download differentially, fallback to full download: Error: sha512 checksum mismatch/)
    assert.equal(sha512(run.file), sha512(v3))
  })

  test('with no provable base the package is downloaded once, in full, without a differential attempt', async () => {
    const run = await runWindowsUpdate({ installed: noise('msi-era', 2 * MB), cachedBlockMap: '1.0.2', withCheck: true })

    assert.doesNotMatch(run.lines, /Differential download|Cannot download differentially/)
    assert.equal(run.servedPackage, v3.length)
    assert.equal(sha512(run.file), sha512(v3))
  })
})

// ---------------------------------------------------------------------------
// Contract with what ships: names and electron-updater internals this relies on.
// ---------------------------------------------------------------------------

describe('shipped contract', () => {
  const desktopRoot = path.resolve(import.meta.dirname, '..')
  const updaterRoot = path.dirname(require.resolve('electron-updater/package.json'))

  test('artifact names follow package.json build.artifactName', () => {
    const pattern = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')).build.artifactName

    const expand = (os: string, arch: string, ext: string) =>
      pattern.replace('${version}', '0.17.63').replace('${os}', os).replace('${arch}', arch).replace('${ext}', ext)

    assert.equal(artifactName('0.17.63', 'darwin', 'arm64'), expand('mac', 'arm64', 'zip'))
    assert.equal(artifactName('0.17.63', 'win32', 'x64'), expand('win', 'x64', 'exe'))
  })

  test('electron-updater still caches and prefers the files this module repairs', () => {
    const appUpdater = fs.readFileSync(path.join(updaterRoot, 'out', 'AppUpdater.js'), 'utf8')
    const macUpdater = fs.readFileSync(path.join(updaterRoot, 'out', 'MacUpdater.js'), 'utf8')

    assert.match(appUpdater, /async getOrCreateDownloadHelper\(\)/)
    assert.match(appUpdater, /let oldBlockMapData = await getBlockMapFromCacheDir\(this\.downloadedUpdateHelper\.cacheDir\);/)
    assert.match(appUpdater, /const blockMapFile = path\.join\(cacheDir, "current\.blockmap"\);/)
    assert.match(macUpdater, /const CURRENT_MAC_APP_ZIP_FILE_NAME = "update\.zip";/)
    // update.zip is refreshed only while differential downloads are on, which is
    // why the macOS fallback removes the zip instead of setting the flag.
    assert.match(macUpdater, /done: async \(event\) => {\s*if \(!downloadUpdateOptions\.disableDifferentialDownload\) {/)
    assert.equal(require('builder-util-runtime').CURRENT_APP_INSTALLER_FILE_NAME, 'installer.exe')
  })
})
