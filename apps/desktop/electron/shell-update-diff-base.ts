// hc-1058: keep electron-updater's differential download on a matching base.
//
// electron-updater 6.8.9 rebuilds the new package from an old file it keeps in
// its cache dir (Mac `update.zip` = the last DOWNLOADED zip; Windows
// `installer.exe` = the installer that last RAN) plus an "old" blockmap: the
// cached `current.blockmap` when present, else the blockmap of the RUNNING
// version. Those two only describe the same bytes when the last download was
// also installed. On 2026-10-23 0.17.61 was downloaded and never installed:
// update.zip held 0.17.61 while the blockmap came from 0.17.60, so the copied
// "unchanged" blocks were wrong, the result failed its sha512 and the updater
// downloaded the whole package again after 368 MB of differential download.
//
// Before each check this module proves which blockmap describes the cached old
// file (sampled chunk checksums: blake2b-18, the blockmap's own hash) and leaves
// exactly that one as `current.blockmap`. With no provable base it removes the
// stale pair so the updater takes its own full-download path once instead of a
// doomed differential first. The sha512 check on the rebuilt file stays the
// final guard either way.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const CURRENT_BLOCKMAP = 'current.blockmap'
const SAMPLE_EDGE = 16
const SAMPLE_SPREAD = 32
const FETCH_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// BLAKE2b (RFC 7693) with a caller-chosen digest length. electron-builder's
// blockmap stores base64(blake2b, 18-byte digest) per chunk; Node's crypto only
// offers the 64-byte variant, and the digest length is part of the parameter
// block (not a truncation), so it cannot be derived from that.
// ---------------------------------------------------------------------------

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
])

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
]

// 64-bit words live as (lo, hi) pairs: word i is v[2i], v[2i+1].
function mix(v: Uint32Array, a: number, b: number, c: number, d: number, m: Uint32Array, x: number, y: number) {
  a *= 2; b *= 2; c *= 2; d *= 2; x *= 2; y *= 2
  let lo = v[a] + v[b]
  let hi = v[a + 1] + v[b + 1] + (lo > 0xffffffff ? 1 : 0)
  lo = (lo >>> 0) + m[x]
  hi = hi + m[x + 1] + (lo > 0xffffffff ? 1 : 0)
  v[a] = lo; v[a + 1] = hi
  // d = rotr64(d ^ a, 32)
  let dl = v[d] ^ v[a]
  let dh = v[d + 1] ^ v[a + 1]
  v[d] = dh; v[d + 1] = dl
  // c = c + d
  lo = v[c] + v[d]
  v[c + 1] = v[c + 1] + v[d + 1] + (lo > 0xffffffff ? 1 : 0); v[c] = lo
  // b = rotr64(b ^ c, 24)
  let bl = v[b] ^ v[c]
  let bh = v[b + 1] ^ v[c + 1]
  v[b] = (bl >>> 24) | (bh << 8); v[b + 1] = (bh >>> 24) | (bl << 8)
  lo = v[a] + v[b]
  hi = v[a + 1] + v[b + 1] + (lo > 0xffffffff ? 1 : 0)
  lo = (lo >>> 0) + m[y]
  hi = hi + m[y + 1] + (lo > 0xffffffff ? 1 : 0)
  v[a] = lo; v[a + 1] = hi
  // d = rotr64(d ^ a, 16)
  dl = v[d] ^ v[a]; dh = v[d + 1] ^ v[a + 1]
  v[d] = (dl >>> 16) | (dh << 16); v[d + 1] = (dh >>> 16) | (dl << 16)
  lo = v[c] + v[d]
  v[c + 1] = v[c + 1] + v[d + 1] + (lo > 0xffffffff ? 1 : 0); v[c] = lo
  // b = rotr64(b ^ c, 63) = rotl64(b ^ c, 1)
  bl = v[b] ^ v[c]; bh = v[b + 1] ^ v[c + 1]
  v[b] = (bl << 1) | (bh >>> 31); v[b + 1] = (bh << 1) | (bl >>> 31)
}

function compress(h: Uint32Array, block: Uint8Array, counter: number, last: boolean) {
  const v = new Uint32Array(32)
  const m = new Uint32Array(32)

  for (let i = 0; i < 16; i++) {v[i] = h[i]; v[i + 16] = IV[i]}
  v[24] ^= counter >>> 0
  v[25] ^= Math.floor(counter / 0x100000000) >>> 0

  if (last) {v[28] = ~v[28]; v[29] = ~v[29]}

  for (let i = 0; i < 32; i++) {
    const o = i * 4
    m[i] = (block[o] | (block[o + 1] << 8) | (block[o + 2] << 16) | (block[o + 3] << 24)) >>> 0
  }

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10]
    mix(v, 0, 4, 8, 12, m, s[0], s[1])
    mix(v, 1, 5, 9, 13, m, s[2], s[3])
    mix(v, 2, 6, 10, 14, m, s[4], s[5])
    mix(v, 3, 7, 11, 15, m, s[6], s[7])
    mix(v, 0, 5, 10, 15, m, s[8], s[9])
    mix(v, 1, 6, 11, 12, m, s[10], s[11])
    mix(v, 2, 7, 8, 13, m, s[12], s[13])
    mix(v, 3, 4, 9, 14, m, s[14], s[15])
  }

  for (let i = 0; i < 16; i++) {h[i] = h[i] ^ v[i] ^ v[i + 16]}
}

function blake2b(data: Uint8Array, outLength: number): Buffer {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) {throw new RangeError('blake2b digest length must be 1..64')}
  const h = new Uint32Array(IV)
  h[0] ^= 0x01010000 ^ outLength
  const block = new Uint8Array(128)
  let offset = 0

  // Every full block except the final one is compressed with last=false; the
  // final (possibly partial or empty) block carries the total length.
  while (data.length - offset > 128) {
    compress(h, data.subarray(offset, offset + 128), offset + 128, false)
    offset += 128
  }

  block.fill(0)
  block.set(data.subarray(offset))
  compress(h, block, data.length, true)
  const out = Buffer.alloc(64)

  for (let i = 0; i < 16; i++) {out.writeUInt32LE(h[i] >>> 0, i * 4)}

  return out.subarray(0, outLength)
}

// ---------------------------------------------------------------------------
// blockmap ↔ file proof
// ---------------------------------------------------------------------------

interface BlockMap {
  version: string
  files: Array<{ name: string; offset: number; checksums: string[]; sizes: number[] }>
}

function parseBlockMap(gzipped: Buffer): BlockMap | null {
  try {
    const map = JSON.parse(zlib.gunzipSync(gzipped).toString('utf8'))
    const file = map?.files?.[0]

    if (map.files.length !== 1 || !Array.isArray(file.checksums) || !Array.isArray(file.sizes) ||
        file.checksums.length !== file.sizes.length || !file.sizes.length) {return null}

    return map
  } catch {
    return null
  }
}

function sampleIndexes(count: number): number[] {
  const picked = new Set<number>()

  for (let i = 0; i < Math.min(SAMPLE_EDGE, count); i++) {picked.add(i); picked.add(count - 1 - i)}

  for (let i = 1; i <= SAMPLE_SPREAD; i++) {picked.add(Math.floor((i * count) / (SAMPLE_SPREAD + 1)))}

  return [...picked].sort((a, b) => a - b)
}

/**
 * True when `file` is the byte stream `map` describes: same total length, and
 * every sampled chunk hashes to its recorded blake2b-18. Two different builds
 * share almost no chunks (0 of 23,984 between the 0.17.61 blockmap and the
 * 0.17.62 zip), so a sample separates them with no realistic false positive;
 * the updater's sha512 on the rebuilt file still guards the rest.
 */
async function blockMapDescribesFile(file: string, map: BlockMap): Promise<boolean> {
  const { offset, sizes, checksums } = map.files[0]
  const starts = new Array<number>(sizes.length)
  let total = offset

  for (let i = 0; i < sizes.length; i++) {starts[i] = total; total += sizes[i]}
  const handle = await fs.promises.open(file, 'r')

  try {
    if ((await handle.stat()).size !== total) {return false}

    for (const index of sampleIndexes(sizes.length)) {
      const chunk = Buffer.alloc(sizes[index])
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, starts[index])

      if (bytesRead !== chunk.length || blake2b(chunk, 18).toString('base64') !== checksums[index]) {return false}
    }

    return true
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// prepare the cache before a check
// ---------------------------------------------------------------------------

type DiffBaseOutcome =
  | { base: 'none' } // no cached old file: the updater downloads in full on its own
  | { base: 'cached' } // current.blockmap already describes the old file
  | { base: 'repaired'; version: string } // wrote the blockmap that does
  | { base: 'dropped'; tried: string[] } // nothing describes it: stale base removed

interface DiffBaseOptions {
  cacheDir: string
  platform: string
  arch: string
  appVersion: string | null
  feedUrl: string
  fetchBuffer?: (url: string) => Promise<Buffer>
  log?: (line: string) => void
}

function oldFileName(platform: string): string | null {
  if (platform === 'darwin') {return 'update.zip'}

  if (platform === 'win32') {return 'installer.exe'}

  return null
}

// Same names as package.json build.artifactName (APEX-${version}-${os}-${arch}.${ext}).
function artifactName(version: string, platform: string, arch: string): string {
  return platform === 'darwin' ? `APEX-${version}-mac-${arch}.zip` : `APEX-${version}-win-${arch}.exe`
}

function pendingDownloadName(cacheDir: string): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(cacheDir, 'pending', 'update-info.json'), 'utf8'))

    return typeof info?.fileName === 'string' && /^[\w.-]+$/.test(info.fileName) ? info.fileName : null
  } catch {
    return null
  }
}

function versionOf(fileName: string): string | null {
  return /-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(?:mac|win)-/.exec(fileName)?.[1] ?? null
}

// Electron's net follows the system proxy like electron-updater's own requests;
// outside Electron (tests, tools) the import yields no `net` and Node's fetch is used.
async function fetchWithTimeout(url: string): Promise<Buffer> {
  const net = await import('electron').then((electron: any) => electron.net ?? electron.default?.net, () => null)
  const get = typeof net?.fetch === 'function' ? net.fetch.bind(net) : fetch
  const response = await get(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

  if (!response.ok) {throw new Error(`HTTP ${response.status}`)}

  return Buffer.from(await response.arrayBuffer())
}

function writeAtomic(file: string, data: Buffer) {
  const tmp = `${file}.${process.pid}.tmp`

  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/**
 * Leave the updater cache with a provable (old file, current.blockmap) pair.
 * Returns whether this round must skip the differential: only on Windows,
 * where the old file belongs to the installer and must stay. On macOS the
 * updater refreshes update.zip only while differential downloads are enabled,
 * so there the stale zip is removed instead and the flag stays off.
 */
async function prepareDifferentialBase(options: DiffBaseOptions): Promise<{ outcome: DiffBaseOutcome; disableDifferential: boolean }> {
  const { cacheDir, platform, arch, appVersion, feedUrl, fetchBuffer = fetchWithTimeout, log = () => {} } = options
  const name = oldFileName(platform)
  const oldFile = name ? path.join(cacheDir, name) : null
  const blockMapFile = path.join(cacheDir, CURRENT_BLOCKMAP)

  if (!oldFile || !fs.existsSync(oldFile)) {return { outcome: { base: 'none' }, disableDifferential: false }}

  const cached = fs.existsSync(blockMapFile) ? parseBlockMap(fs.readFileSync(blockMapFile)) : null

  if (cached && await blockMapDescribesFile(oldFile, cached)) {return { outcome: { base: 'cached' }, disableDifferential: false }}

  // Mac: update.zip is the last download, named in pending/update-info.json.
  // Windows: installer.exe is the running version's installer.
  const pending = platform === 'darwin' ? pendingDownloadName(cacheDir) : null

  const candidates = [...new Set([
    ...(pending ? [pending] : []),
    ...(appVersion ? [artifactName(appVersion, platform, arch)] : [])
  ])]

  for (const candidate of candidates) {
    let map: BlockMap | null = null

    try {
      map = parseBlockMap(await fetchBuffer(`${feedUrl}/${candidate}.blockmap`))
    } catch (error: any) {
      log(`[shell-update] diff base: cannot fetch ${candidate}.blockmap: ${error?.message || error}`)
    }

    if (map && await blockMapDescribesFile(oldFile, map)) {
      writeAtomic(blockMapFile, zlib.gzipSync(JSON.stringify(map)))
      const version = versionOf(candidate) || candidate
      log(`[shell-update] diff base: ${name} is ${version}; cached its blockmap`)

      return { outcome: { base: 'repaired', version }, disableDifferential: false }
    }
  }

  fs.rmSync(blockMapFile, { force: true })

  if (platform === 'darwin') {fs.rmSync(oldFile, { force: true })}
  log(`[shell-update] diff base: no blockmap describes ${name} (tried ${candidates.join(', ') || 'none'}); ` +
    `this download goes in full`)

  return { outcome: { base: 'dropped', tried: candidates }, disableDifferential: platform === 'win32' }
}

export { artifactName, blake2b, blockMapDescribesFile, parseBlockMap, prepareDifferentialBase }
export type { DiffBaseOptions, DiffBaseOutcome }
