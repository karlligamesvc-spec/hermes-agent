// hc-1233: Node 24 and later need macOS 13.5, the engine bundles Node 26 from 0.18.0 on, and the app still declared
// Electron's 12.0, so a Mac on 12.0-13.4 would have updated into an engine that cannot start. These pin the floor,
// the feed stamp that keeps those Macs on their version, and the scan that keeps every bundled binary within it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  darwinRelease,
  declaredFloor,
  feedMinimumSystemVersion,
  fileMinimumMacOS,
  plistMinimumSystemVersion,
  scanMinimumMacOS,
  stampFeed
} from './macos-minimum-system.mjs'

const require = createRequire(import.meta.url)
const semver = require('semver')
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const script = path.join(here, 'macos-minimum-system.mjs')

// The oldest macOS each Node major runs on: nodejs/node BUILDING.md, "Supported platforms", macOS arm64.
const NODE_MACOS_FLOOR = { 22: '11.0', 24: '13.5', 26: '13.5' }

// Verbatim desktop/mac-arm64/latest-mac.yml as 0.17.76 shipped it.
const FEED_0_17_76 = `version: 0.17.76
files:
  - url: APEX-0.17.76-mac-arm64.zip
    sha512: BmsPPAUx+UCiEhiB+jmT1jayjemyNJdCvyb9+i32b6FpT3rWudvt7yGATiDd63YyI+ZNKuuMQi+ceZNGlXBHrg==
    size: 516498217
  - url: APEX-0.17.76-mac-arm64.dmg
    sha512: ekMjIUzq0MJckKtGydgZDbJVoThHju0oP+Q03ItD8hPY1+qe6URiTUWAinQ4vJMuJGG9lSh8dxifVVotGcZ1kg==
    size: 518676225
path: APEX-0.17.76-mac-arm64.zip
sha512: BmsPPAUx+UCiEhiB+jmT1jayjemyNJdCvyb9+i32b6FpT3rWudvt7yGATiDd63YyI+ZNKuuMQi+ceZNGlXBHrg==
releaseDate: '2026-11-09T18:30:36.826Z'
`

const ARM64 = 0x0100000c
const X86_64 = 0x01000007

// A 64-bit little-endian Mach-O image whose one load command declares `minos`: LC_BUILD_VERSION (platform macOS),
// LC_VERSION_MIN_MACOSX for `legacy`, or none at all for null.
function machO(minos, { cpu = ARM64, legacy = false } = {}) {
  const command = minos === null ? Buffer.alloc(0) : Buffer.alloc(legacy ? 16 : 24)
  if (minos !== null) {
    const [major, minor = 0, patch = 0] = minos.split('.').map(Number)
    command.writeUInt32LE(legacy ? 0x24 : 0x32, 0)
    command.writeUInt32LE(command.length, 4)
    if (!legacy) command.writeUInt32LE(1, 8)
    command.writeUInt32LE((major << 16) | (minor << 8) | patch, legacy ? 8 : 12)
  }
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpu, 4)
  header.writeUInt32LE(2, 12)
  header.writeUInt32LE(minos === null ? 0 : 1, 16)
  header.writeUInt32LE(command.length, 20)
  return Buffer.concat([header, command, Buffer.alloc(64)])
}

// A universal binary, slices 4 KiB apart as lipo aligns them.
function fat(slices) {
  const out = Buffer.alloc(4096 * (slices.length + 1))
  out.writeUInt32BE(0xcafebabe, 0)
  out.writeUInt32BE(slices.length, 4)
  slices.forEach(([cpu, image], index) => {
    const offset = 4096 * (index + 1)
    out.writeUInt32BE(cpu, 8 + 20 * index)
    out.writeUInt32BE(offset, 16 + 20 * index)
    out.writeUInt32BE(image.length, 20 + 20 * index)
    image.copy(out, offset)
  })
  return out
}

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return file
}

const plist = minimum => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>CFBundleName</key>
    <string>APEX</string>
    <key>LSMinimumSystemVersion</key>
    <string>${minimum}</string>
  </dict>
</plist>
`

test('the declared floor covers the Node the engine bundles', () => {
  // The bundle stages exactly pm/lock.json's Node (bundle-node-version.node-test.mjs).
  const node = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pm', 'lock.json'), 'utf8')).packages.node.version
  const major = semver.major(node)
  assert.ok(Object.hasOwn(NODE_MACOS_FLOOR, major),
    `pm/lock.json pins Node ${node}: add Node ${major}'s oldest macOS (BUILDING.md) to NODE_MACOS_FLOOR, and raise build.mac.minimumSystemVersion if it is newer`)
  const floor = declaredFloor()
  assert.ok(semver.gte(semver.coerce(floor), semver.coerce(NODE_MACOS_FLOOR[major])),
    `Node ${node} needs macOS ${NODE_MACOS_FLOOR[major]}, but the app declares ${floor}`)
})

test('the feed names the floor as the Darwin version os.release() reports on it', () => {
  assert.equal(declaredFloor(), '13.5')
  assert.equal(feedMinimumSystemVersion(), '22.6.0')
  assert.equal(darwinRelease('13.5'), '22.6.0')
  assert.throws(() => darwinRelease('99.0'), /no Darwin version recorded for macOS 99.0: add it to MACOS_DARWIN/)
  assert.throws(() => declaredFloor({ build: { mac: {} } }), /not a macOS version: undefined/)
})

test('stamping adds one quoted top-level line and keeps every other byte', () => {
  const stamped = stampFeed(FEED_0_17_76, '22.6.0')
  assert.equal(stamped, `${FEED_0_17_76}minimumSystemVersion: '22.6.0'\n`)
  assert.equal(stampFeed(stamped, '22.6.0'), stamped)
  assert.equal(stampFeed(stamped, '23.0.0'), `${FEED_0_17_76}minimumSystemVersion: '23.0.0'\n`)
  assert.equal(stampFeed(FEED_0_17_76.trimEnd(), '22.6.0'), stamped)
  assert.throws(() => stampFeed(FEED_0_17_76, '13.5'), /not a Darwin version: 13.5/)
})

test("the installed shell's electron-updater offers a stamped release only from macOS 13.5 on", t => {
  // The same parse and check the shipped electron-updater runs on the feed it downloads.
  const { AppUpdater } = require('electron-updater/out/AppUpdater')
  const yaml = require('js-yaml')
  const stamped = yaml.load(stampFeed(FEED_0_17_76.replaceAll('0.17.76', '0.18.0'), feedMinimumSystemVersion()))
  const unstamped = yaml.load(FEED_0_17_76.replaceAll('0.17.76', '0.18.0'))
  assert.equal(typeof stamped.minimumSystemVersion, 'string')
  const release = os.release
  t.after(() => { os.release = release })
  const updater = { _logger: { info() {}, warn() {} } }
  const supported = (info, darwin) => {
    os.release = () => darwin
    return AppUpdater.prototype.checkIfUpdateSupported.call(updater, info)
  }
  for (const [darwin, macos, offered] of [
    ['21.6.0', '12.7', false],
    ['22.5.0', '13.4', false],
    ['22.6.0', '13.5', true],
    ['23.0.0', '14.0', true],
    ['25.0.0', '26.0', true]
  ]) {
    assert.equal(supported(stamped, darwin), offered, `macOS ${macos} (Darwin ${darwin})`)
    // Without the stamp, every Mac is offered the release, as 0.18.0's first candidate would have been.
    assert.equal(supported(unstamped, darwin), true, `unstamped, macOS ${macos}`)
  }
})

test('the scan reads the minimum macOS a Mach-O declares, from the slice macOS runs', t => {
  const dir = tempDir(t, 'macos-minimum-read')
  const read = (name, bytes, arch = 'arm64') => fileMinimumMacOS(writeFile(path.join(dir, name), bytes), arch)
  assert.equal(read('thin', machO('13.5')), '13.5.0')
  assert.equal(read('legacy', machO('11.0', { legacy: true })), '11.0.0')
  assert.equal(read('no-version', machO(null)), null)
  const universal = fat([[X86_64, machO('15.0', { cpu: X86_64 })], [ARM64, machO('13.5')]])
  assert.equal(read('universal-arm64', universal), '13.5.0')
  assert.equal(read('universal-x64', universal, 'x64'), '15.0.0')
  // No arm64 slice: macOS runs the x86_64 one under Rosetta.
  assert.equal(read('intel-only', fat([[X86_64, machO('12.0', { cpu: X86_64 })]])), '12.0.0')
  assert.equal(read('Main.class', Buffer.from('cafebabe00000034000a0700', 'hex')), null)
  assert.equal(read('notes.txt', Buffer.from('not a binary\n')), null)
  assert.equal(read('empty', Buffer.alloc(0)), null)
  if (process.platform === 'darwin') assert.match(fileMinimumMacOS(process.execPath, process.arch), /^\d+\.\d+\.\d+$/)
})

test('the scan lists every Mach-O above the floor, in the app and in the unpacked engine', t => {
  const dir = tempDir(t, 'macos-minimum-scan')
  const app = path.join(dir, 'APEX.app')
  const engine = path.join(dir, 'engine')
  writeFile(path.join(app, 'Contents', 'MacOS', 'APEX'), machO('12.0'))
  writeFile(path.join(engine, '.runtime', 'node', 'bin', 'node'), fat([[X86_64, machO('15.0', { cpu: X86_64 })], [ARM64, machO('13.5')]]))
  writeFile(path.join(engine, '.runtime', 'bin', 'rg'), machO('13.0'))
  writeFile(path.join(engine, 'venv', 'lib', 'future.so'), machO('14.0'))
  writeFile(path.join(engine, 'README.md'), 'text')
  fs.symlinkSync(path.join(engine, 'venv', 'lib', 'future.so'), path.join(engine, 'venv', 'lib', 'link.so'))

  assert.deepEqual(scanMinimumMacOS([app, engine], '13.5', 'arm64'), {
    summary: [{ root: app, count: 1, highest: '12.0.0' }, { root: engine, count: 3, highest: '14.0.0' }],
    above: [`14.0.0  ${path.join('venv', 'lib', 'future.so')}`]
  })
  assert.deepEqual(scanMinimumMacOS([app, engine], '12.0', 'arm64').above.sort(), [
    `13.0.0  ${path.join('.runtime', 'bin', 'rg')}`,
    `13.5.0  ${path.join('.runtime', 'node', 'bin', 'node')}`,
    `14.0.0  ${path.join('venv', 'lib', 'future.so')}`
  ].sort())
})

test('the CLI stamps a feed and refuses an app whose binaries or Info.plist miss the floor', t => {
  const dir = tempDir(t, 'macos-minimum-cli')
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  const feed = writeFile(path.join(dir, 'latest-mac.yml'), FEED_0_17_76)
  const stamp = run('stamp', feed)
  assert.equal(stamp.status, 0, stamp.stderr)
  assert.equal(fs.readFileSync(feed, 'utf8'), `${FEED_0_17_76}minimumSystemVersion: '22.6.0'\n`)

  const app = path.join(dir, 'APEX.app')
  const engine = path.join(dir, 'engine')
  writeFile(path.join(app, 'Contents', 'Info.plist'), plist('13.5'))
  writeFile(path.join(app, 'Contents', 'MacOS', 'APEX'), machO('12.0'))
  const node = writeFile(path.join(engine, '.runtime', 'node', 'bin', 'node'), machO('13.5'))
  assert.equal(plistMinimumSystemVersion(app), '13.5')
  const ok = run('assert', '--arch', 'arm64', app, engine)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /every arm64 binary runs on macOS 13.5/)

  writeFile(node, machO('14.0'))
  const above = run('assert', '--arch', 'arm64', app, engine)
  assert.equal(above.status, 1)
  assert.match(above.stderr, /need a newer macOS than the declared 13.5:\n14.0.0 {2}\.runtime\/node\/bin\/node/)

  writeFile(node, machO('13.5'))
  writeFile(path.join(app, 'Contents', 'Info.plist'), plist('12.0'))
  const plistBelow = run('assert', '--arch', 'arm64', app, engine)
  assert.equal(plistBelow.status, 1)
  assert.match(plistBelow.stderr, /declares LSMinimumSystemVersion 12.0, not package.json's 13.5/)

  writeFile(path.join(app, 'Contents', 'Info.plist'), plist('13.5'))
  const emptyEngine = path.join(dir, 'empty')
  fs.mkdirSync(emptyEngine)
  const wrongPath = run('assert', '--arch', 'arm64', app, emptyEngine)
  assert.equal(wrongPath.status, 1)
  assert.match(wrongPath.stderr, /holds no Mach-O: wrong path\?/)
  assert.match(run('assert', app).stderr, /usage: macos-minimum-system.mjs/)
})
