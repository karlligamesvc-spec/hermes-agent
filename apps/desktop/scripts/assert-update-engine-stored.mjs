// hc-1058: the updater packages must carry the engine archive byte for byte.
//
// The engine archive is built to be block-diffable (scripts/runtime-bundle-archive.mjs),
// but electron-updater diffs the OUTER package: the Mac update zip and the Windows
// NSIS installer. If either re-compresses the archive, every byte after the first
// change differs again and each release re-downloads the whole engine.
//
//   macOS   electron-builder 26 writes the update zip with Info-ZIP `zip -r -y -7`,
//           which stores (does not deflate) the suffixes listed in ZIPOPT `-n`.
//           afterPack sets it; `mac-zip` proves the shipped zip stored the entry.
//   Windows nsis.preCompressedFileExtensions keeps `.tar.gz` out of the LZMA 7z and
//           adds it as its own NSIS File under SetCompress auto (zlib cannot
//           shrink gzip data, so NSIS stores it). `nsis` proves the installer
//           holds the archive verbatim, and that no other `.tar.gz` was dropped:
//           electron-builder excludes every match from the 7z but re-adds only
//           those under resources/ outside node_modules.
//
// usage: node scripts/assert-update-engine-stored.mjs mac-zip <APEX-*.zip>
//        node scripts/assert-update-engine-stored.mjs nsis <APEX-*-win-x64.exe> <win-unpacked dir>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Info-ZIP's own default no-compress list (`-n` replaces it) plus gzip.
export const MAC_ZIP_STORED_SUFFIXES = '.Z:.zip:.zoo:.arc:.lzh:.arj:.gz'
export const ENGINE_ARCHIVE_SUFFIX = '.tar.gz'
const ENGINE_ENTRY = /(^|\/)Contents\/Resources\/bundled-runtime\/runtime-bundle-[^/]+\.tar\.gz$/

export function storeEngineInMacUpdateZip(env = process.env) {
  env.ZIPOPT = `-n ${MAC_ZIP_STORED_SUFFIXES}`
  return env.ZIPOPT
}

/** Central directory of a (non-zip64) zip: name, method, sizes per entry. */
export function readZipEntries(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tailLength = Math.min(size, 65_535 + 22)
    const tail = Buffer.alloc(tailLength)
    fs.readSync(fd, tail, 0, tailLength, size - tailLength)
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (eocd < 0) throw new Error(`${file}: no zip end-of-central-directory record`)
    const count = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error(`${file}: zip64 archives are not expected here`)
    const directory = Buffer.alloc(directorySize)
    fs.readSync(fd, directory, 0, directorySize, directoryOffset)
    const entries = []
    for (let at = 0, i = 0; i < count; i++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}: corrupt central directory at entry ${i}`)
      const nameLength = directory.readUInt16LE(at + 28)
      entries.push({
        name: directory.toString('utf8', at + 46, at + 46 + nameLength),
        method: directory.readUInt16LE(at + 10),
        compressedSize: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24)
      })
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32)
    }
    return entries
  } finally { fs.closeSync(fd) }
}

export function assertMacUpdateZipStoresEngine(zipFile) {
  const engines = readZipEntries(zipFile).filter(entry => ENGINE_ENTRY.test(entry.name))
  if (engines.length !== 1) throw new Error(`${zipFile}: expected one bundled engine archive, found ${engines.length}`)
  const [engine] = engines
  if (engine.method !== 0 || engine.compressedSize !== engine.size) {
    throw new Error(`${zipFile}: ${engine.name} is compressed (method ${engine.method}); ` +
      'set ZIPOPT via afterPack so every release does not re-download the whole engine')
  }
  return engine
}

/** True `.tar.gz` files NSIS would leave out: outside resources/ or inside a node_modules dir. */
export function nsisDroppedArchives(appDir) {
  const dropped = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel)
      else if (entry.name.endsWith(ENGINE_ARCHIVE_SUFFIX) &&
        (!childRel.startsWith('resources/') || childRel.split('/').includes('node_modules'))) dropped.push(childRel)
    }
  }
  walk(appDir, '')
  return dropped.sort()
}

export function assertNsisInstallerStoresEngine(installer, appDir) {
  const dropped = nsisDroppedArchives(appDir)
  if (dropped.length) throw new Error(`NSIS would drop these ${ENGINE_ARCHIVE_SUFFIX} files from the installer: ${dropped.join(', ')}`)
  const runtimeDir = path.join(appDir, 'resources', 'bundled-runtime')
  const archives = fs.readdirSync(runtimeDir).filter(name => name.endsWith(ENGINE_ARCHIVE_SUFFIX))
  if (archives.length !== 1) throw new Error(`${runtimeDir}: expected one engine archive, found ${archives.length}`)
  const archive = fs.readFileSync(path.join(runtimeDir, archives[0]))
  const image = fs.readFileSync(installer)
  const offset = image.indexOf(archive.subarray(0, Math.min(archive.length, 1 << 20)))
  if (offset < 0 || !image.subarray(offset, offset + archive.length).equals(archive)) {
    throw new Error(`${installer}: ${archives[0]} is not stored verbatim (compressed by NSIS or packed into the 7z)`)
  }
  return { archive: archives[0], offset, size: archive.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2)
  try {
    if (command === 'mac-zip' && first) console.log(JSON.stringify(assertMacUpdateZipStoresEngine(path.resolve(first))))
    else if (command === 'nsis' && first && second) console.log(JSON.stringify(assertNsisInstallerStoresEngine(path.resolve(first), path.resolve(second))))
    else throw new Error('usage: assert-update-engine-stored.mjs mac-zip <zip> | nsis <installer.exe> <win-unpacked>')
  } catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1 }
}
