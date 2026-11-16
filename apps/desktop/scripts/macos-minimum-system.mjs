import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// hc-1233: the oldest macOS a Desktop release runs on, and the two places a Mac enforces it.
//
// Node 24 and later need macOS 13.5 (Node 22 needed 11.0). The engine bundles Node 26 from 0.18.0 on, and the
// engine install itself runs that Node, so on an older macOS an update lands and the engine never starts. The app
// declares one floor, build.mac.minimumSystemVersion in package.json, and a Mac enforces it in two places:
//   Info.plist      electron-builder writes it as LSMinimumSystemVersion. Finder will not open the app on an older
//                   macOS and says which macOS it needs.
//   latest-mac.yml  the release build stamps it as minimumSystemVersion, a Darwin version. The installed shell's
//                   electron-updater (6.3 and later; APEX has shipped 6.8.9 since 0.17.0) compares it with
//                   os.release() and offers no update to an older Mac, which keeps the version it has.
// electron-builder writes only the plist, hence `stamp`. `assert` proves that no Mach-O in the app or in its engine
// archive needs a newer macOS than the floor. Node built-ins only: the publish job runs this without npm ci.

const PACKAGE_JSON = new URL('../package.json', import.meta.url)

// The Darwin version os.release() reports on the first release of each macOS a floor may name (13.4 reports
// 22.5.0; 13.5 and 13.6 report 22.6.0). Add a row before raising the floor: an unknown floor fails the release
// build instead of stamping a feed that no updater can compare.
export const MACOS_DARWIN = Object.freeze({ '13.5': '22.6.0' })

export function declaredFloor(pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))) {
  const floor = pkg?.build?.mac?.minimumSystemVersion
  assert.match(String(floor ?? ''), /^\d+\.\d+(?:\.\d+)?$/, `package.json build.mac.minimumSystemVersion is not a macOS version: ${floor}`)
  return floor
}

export function darwinRelease(macos) {
  assert.ok(Object.hasOwn(MACOS_DARWIN, macos), `no Darwin version recorded for macOS ${macos}: add it to MACOS_DARWIN`)
  return MACOS_DARWIN[macos]
}

// The minimumSystemVersion a Mac feed must carry for the floor package.json declares.
export function feedMinimumSystemVersion(pkg) {
  return darwinRelease(declaredFloor(pkg))
}

const FEED_LINE = /^minimumSystemVersion:.*$/m

// The feed with one top-level `minimumSystemVersion: '<darwin>'` line and every other line kept. Quoted so YAML
// reads a string: electron-updater's semver.lt throws on a number, and the updater then allows the update.
export function stampFeed(text, darwin) {
  assert.match(darwin, /^\d+\.\d+\.\d+$/, `not a Darwin version: ${darwin}`)
  const line = `minimumSystemVersion: '${darwin}'`
  return FEED_LINE.test(text) ? text.replace(FEED_LINE, line) : `${text.replace(/\n*$/, '\n')}${line}\n`
}

export function plistMinimumSystemVersion(app) {
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8')
  return /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
}

const CPU_TYPE = Object.freeze({ arm64: 0x0100000c, x64: 0x01000007 })
const LC_VERSION_MIN_MACOSX = 0x24
const LC_BUILD_VERSION = 0x32
const PLATFORM_MACOS = 1

function readAt(fd, position, length) {
  const bytes = Buffer.alloc(length)
  return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, position))
}

// The minimum macOS of the thin Mach-O image at `start`: LC_BUILD_VERSION, or the older LC_VERSION_MIN_MACOSX.
function imageMinimum(fd, start) {
  const header = readAt(fd, start, 32)
  if (header.length < 28) return null
  const magic = header.readUInt32LE(0)
  const little = magic === 0xfeedfacf || magic === 0xfeedface
  if (!little && magic !== 0xcffaedfe && magic !== 0xcefaedfe) return null
  const headerSize = magic === 0xfeedfacf || magic === 0xcffaedfe ? 32 : 28
  const commands = readAt(fd, start, headerSize + (little ? header.readUInt32LE(20) : header.readUInt32BE(20)))
  const word = at => little ? commands.readUInt32LE(at) : commands.readUInt32BE(at)
  const count = word(16)
  for (let index = 0, at = headerSize; index < count && at + 16 <= commands.length; index += 1) {
    const [command, size] = [word(at), word(at + 4)]
    const encoded = command === LC_BUILD_VERSION && word(at + 8) === PLATFORM_MACOS ? word(at + 12)
      : command === LC_VERSION_MIN_MACOSX ? word(at + 8) : null
    if (encoded !== null) return `${encoded >>> 16}.${(encoded >>> 8) & 0xff}.${encoded & 0xff}`
    if (size < 8) break
    at += size
  }
  return null
}

// The oldest macOS a Mach-O file runs on, or null for anything else. A fat file counts its `arch` slice, the one
// macOS runs; without one, macOS runs another slice under Rosetta, so the most demanding counts. A Java .class
// also starts with cafebabe, but its next word is a class version, never a slice count of 1-20.
export function fileMinimumMacOS(file, arch) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = readAt(fd, 0, 8)
    if (head.length < 8) return null
    const fat = head.readUInt32BE(0)
    if ((fat !== 0xcafebabe && fat !== 0xcafebabf) || head.readUInt32BE(4) < 1 || head.readUInt32BE(4) > 20) return imageMinimum(fd, 0)
    const entry = fat === 0xcafebabe ? 20 : 32
    const table = readAt(fd, 8, entry * head.readUInt32BE(4))
    const slices = []
    for (let at = 0; at + entry <= table.length; at += entry) {
      slices.push({ cpu: table.readUInt32BE(at), offset: fat === 0xcafebabe ? table.readUInt32BE(at + 8) : Number(table.readBigUInt64BE(at + 8)) })
    }
    const native = slices.filter(slice => slice.cpu === CPU_TYPE[arch])
    const minimums = (native.length > 0 ? native : slices).map(slice => imageMinimum(fd, slice.offset)).filter(Boolean)
    return minimums.sort(compareMacOS).at(-1) ?? null
  } finally {
    fs.closeSync(fd)
  }
}

export function compareMacOS(a, b) {
  const [left, right] = [a, b].map(version => version.split('.').map(Number))
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0) ? -1 : 1
  }
  return 0
}

function* regularFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) yield* regularFiles(full)
    else if (entry.isFile()) yield full
  }
}

// Each root's Mach-O count and highest minimum, and every file whose `arch` code needs a newer macOS than `floor`.
export function scanMinimumMacOS(roots, floor, arch) {
  assert.ok(Object.hasOwn(CPU_TYPE, arch), `unknown Mac architecture: ${arch}`)
  const summary = []
  const above = []
  for (const root of roots) {
    let count = 0
    let highest = null
    for (const file of regularFiles(root)) {
      const minimum = fileMinimumMacOS(file, arch)
      if (minimum === null) continue
      count += 1
      if (highest === null || compareMacOS(minimum, highest) > 0) highest = minimum
      if (compareMacOS(minimum, floor) > 0) above.push(`${minimum}  ${path.relative(root, file)}`)
    }
    summary.push({ root, count, highest })
  }
  return { summary, above }
}

const USAGE = 'usage: macos-minimum-system.mjs stamp <latest-mac.yml> | assert --arch <arm64|x64> <app> [<dir>...]'

function main([command, ...rest]) {
  if (command === 'stamp' && rest.length === 1) {
    const darwin = feedMinimumSystemVersion()
    fs.writeFileSync(rest[0], stampFeed(fs.readFileSync(rest[0], 'utf8'), darwin))
    console.log(`${rest[0]}: minimumSystemVersion '${darwin}' (macOS ${declaredFloor()})`)
    return
  }
  assert.ok(command === 'assert' && rest[0] === '--arch' && rest.length >= 3, USAGE)
  const [, arch, app, ...dirs] = rest
  const floor = declaredFloor()
  assert.equal(plistMinimumSystemVersion(app), floor, `${app} declares LSMinimumSystemVersion ${plistMinimumSystemVersion(app)}, not package.json's ${floor}`)
  const { summary, above } = scanMinimumMacOS([app, ...dirs], floor, arch)
  for (const { root, count, highest } of summary) console.log(`${root}: ${count} Mach-O, highest minimum macOS ${highest}`)
  assert.ok(summary.every(({ count }) => count > 0), 'a scanned root holds no Mach-O: wrong path?')
  assert.deepEqual(above, [], `these ${arch} binaries need a newer macOS than the declared ${floor}:\n${above.join('\n')}`)
  console.log(`every ${arch} binary runs on macOS ${floor}`)
}

// Compared as real paths: run through a symlink, a URL comparison would skip every check and still exit 0.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
