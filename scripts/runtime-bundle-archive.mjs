// ============================================================================
// runtime-bundle-archive.mjs — deterministic, diff-friendly runtime bundle archive (hc-1058)
// ============================================================================
// The Desktop shell ships the engine as runtime-bundle-<key>-<os>-<arch>.tar.gz
// inside the App, and electron-updater downloads a new shell by content-defined
// blocks (electron-builder blockmap). `tar -czf` made that useless: entry order,
// mtimes and owners followed the build machine, and one gzip stream means every
// byte after the first change differs. Each release re-downloaded the whole
// ~350 MB engine (75% of the Mac zip, 81% of the Windows installer).
//
// This writer produces the same kind of archive (ustar + pax, gzip; bsdtar and
// GNU tar extract it like before) whose bytes depend only on the tree:
//   - entries sorted by name, the root first and every directory before its
//     children; mtime fixed, owner 0/0 with no names, the file's own mode bits;
//   - gzip in content-defined segments (~64 KiB) that are deflated on their
//     own and end on a full flush, so unchanged regions compress to identical
//     bytes wherever they sit (the idea behind `gzip --rsyncable`).
// Between two real engines (1fd75201 → a2e1a4b5) the blockmap download fell
// from 360 MB (99.3%) to 20.9 MB (5.6%); the archive grew by 3.4%.
//
// The gear table, segment sizes, deflate level and fixed mtime are part of the
// format: changing any of them makes the next release a full download once.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const ARCHIVE_MTIME = 946684800 // 2000-01-01T00:00:00Z on every entry
const SEGMENT_MIN = 16 * 1024
const SEGMENT_MAX = 256 * 1024
const SEGMENT_MASK = 0xffff0000 // top 16 bits clear: ~64 KiB average segment
const DEFLATE_LEVEL = 6
const READ_CHUNK = 4 * 1024 * 1024
const MAX_USTAR_SIZE = 0o77777777777

// 256 fixed pseudo-random words (a simple seeded mixer). Never regenerate.
const GEAR = (() => {
  const table = new Uint32Array(256)
  let seed = 0x9e3779b9
  for (let i = 0; i < 256; i++) {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + i) >>> 0
    table[i] = seed
  }
  return table
})()

// The root, then every entry depth-first in byte order of the name, each
// directory before its children. Sockets and other special files are skipped,
// as the files index skips them.
function* archiveEntries(root, rel = '') {
  if (!rel) yield { rel: '', abs: root, kind: 'dir' }
  const children = fs.readdirSync(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true })
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const child of children) {
    const childRel = rel ? `${rel}/${child.name}` : child.name
    const abs = path.join(root, ...childRel.split('/'))
    if (child.isSymbolicLink()) yield { rel: childRel, abs, kind: 'link' }
    else if (child.isDirectory()) { yield { rel: childRel, abs, kind: 'dir' }; yield* archiveEntries(root, childRel) }
    else if (child.isFile()) yield { rel: childRel, abs, kind: 'file' }
  }
}

// POSIX keeps the file's own permission bits (they carry the executables).
// Windows reports synthetic modes, so give it the conventional pair.
function entryMode(stat, kind, platform) {
  if (platform === 'win32') return kind === 'dir' ? 0o755 : 0o644
  return stat.mode & 0o777
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

const isAscii = text => /^[\x20-\x7e]*$/.test(text)

// ustar keeps names up to 100 bytes, or a prefix of up to 155 plus a 100-byte
// tail split at a '/'. Anything longer or non-ASCII goes into a pax record.
function splitUstarName(name) {
  if (!isAscii(name)) return null
  if (name.length <= 100) return { prefix: '', name }
  for (let cut = name.indexOf('/'); cut !== -1; cut = name.indexOf('/', cut + 1)) {
    if (cut <= 155 && name.length - cut - 1 <= 100 && name.length - cut - 1 > 0) {
      return { prefix: name.slice(0, cut), name: name.slice(cut + 1) }
    }
  }
  return null
}

function ustarHeader({ name, prefix = '', mode, size, type, linkname = '' }) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(octal(mode, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(ARCHIVE_MTIME, 12), 136)
  header.write('        ', 148)
  header.write(type, 156)
  header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${octal(sum, 7)} `, 148)
  return header
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body)
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`)
  return `${length}${body}`
}

const padding = size => Buffer.alloc((512 - (size % 512)) % 512)

/** Gzip writer: content-defined segments, each deflated alone and ended with a full flush. */
class SegmentedGzip {
  constructor(fd) {
    this.fd = fd
    this.pending = []
    this.pendingLength = 0
    this.hash = 0
    this.crc = 0
    this.size = 0
    this.bytes = 0
    this.segments = 0
    this.out(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3])) // no name, mtime 0, unix
  }

  out(buffer) {
    fs.writeSync(this.fd, buffer)
    this.bytes += buffer.length
  }

  emit(segment) {
    this.crc = zlib.crc32(segment, this.crc)
    this.size += segment.length
    this.out(zlib.deflateRawSync(segment, { level: DEFLATE_LEVEL, finishFlush: zlib.constants.Z_FULL_FLUSH }))
    this.segments++
  }

  write(buffer) {
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      this.hash = ((this.hash << 1) + GEAR[buffer[i]]) >>> 0
      const length = this.pendingLength + i - start + 1
      if ((length >= SEGMENT_MIN && (this.hash & SEGMENT_MASK) === 0) || length >= SEGMENT_MAX) {
        this.pending.push(buffer.subarray(start, i + 1))
        this.emit(Buffer.concat(this.pending))
        this.pending = []
        this.pendingLength = 0
        this.hash = 0
        start = i + 1
      }
    }
    if (start < buffer.length) {
      // Copy: callers reuse their read buffer.
      this.pending.push(Buffer.from(buffer.subarray(start)))
      this.pendingLength += buffer.length - start
    }
  }

  finish() {
    if (this.pendingLength) this.emit(Buffer.concat(this.pending))
    this.out(zlib.deflateRawSync(Buffer.alloc(0)))
    const trailer = Buffer.alloc(8)
    trailer.writeUInt32LE(this.crc >>> 0, 0)
    trailer.writeUInt32LE(this.size % 0x100000000, 4)
    this.out(trailer)
    return { segments: this.segments, bytes: this.bytes, tarBytes: this.size }
  }
}

/**
 * Archive `root` into `outFile` as a deterministic gzip'd tar whose entries are
 * named "./", "./<path>" like `tar -czf <out> -C <root> .`.
 */
export function writeRuntimeArchive(root, outFile, { platform = process.platform } = {}) {
  const fd = fs.openSync(outFile, 'w')
  const gzip = new SegmentedGzip(fd)
  const chunk = Buffer.alloc(READ_CHUNK)
  let entries = 0
  try {
    for (const entry of archiveEntries(root)) {
      const stat = fs.lstatSync(entry.abs)
      const name = entry.rel ? `./${entry.rel}${entry.kind === 'dir' ? '/' : ''}` : './'
      const linkname = entry.kind === 'link' ? fs.readlinkSync(entry.abs) : ''
      const size = entry.kind === 'file' ? stat.size : 0
      if (size > MAX_USTAR_SIZE) throw new Error(`${entry.rel} is too large for a ustar entry`)
      const split = splitUstarName(name)
      const records = (split ? '' : paxRecord('path', name)) +
        (linkname && (!isAscii(linkname) || linkname.length > 100) ? paxRecord('linkpath', linkname) : '')
      if (records) {
        const body = Buffer.from(records, 'utf8')
        gzip.write(ustarHeader({ name: 'PaxHeader', mode: 0o644, size: body.length, type: 'x' }))
        gzip.write(body)
        gzip.write(padding(body.length))
      }
      gzip.write(ustarHeader({
        ...(split || { prefix: '', name: 'PaxHeader/name' }),
        mode: entryMode(stat, entry.kind, platform),
        size,
        type: { dir: '5', file: '0', link: '2' }[entry.kind],
        // A target that only fits the pax record still needs a non-empty ustar
        // linkname, or libarchive (bsdtar) drops it; bsdtar writes this placeholder.
        linkname: !linkname ? '' : isAscii(linkname) && linkname.length <= 100 ? linkname : '././@LongSymLink'
      }))
      if (entry.kind === 'file') {
        const file = fs.openSync(entry.abs, 'r')
        try {
          let copied = 0
          for (let read; (read = fs.readSync(file, chunk, 0, chunk.length, copied)) > 0; copied += read) {
            gzip.write(chunk.subarray(0, read))
          }
          if (copied !== size) throw new Error(`${entry.rel} changed size while archiving (${size} → ${copied})`)
        } finally { fs.closeSync(file) }
        gzip.write(padding(size))
      }
      entries++
    }
    gzip.write(Buffer.alloc(1024))
    return { entries, ...gzip.finish() }
  } finally {
    fs.closeSync(fd)
  }
}
