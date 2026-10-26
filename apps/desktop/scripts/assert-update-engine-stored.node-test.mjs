import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'

import {
  assertMacUpdateZipStoresEngine,
  assertNsisInstallerStoresEngine,
  MAC_ZIP_STORED_SUFFIXES,
  nsisDroppedArchives,
  readZipEntries,
  storeEngineInMacUpdateZip
} from './assert-update-engine-stored.mjs'

// hc-1058: the deterministic engine archive only helps if the update packages carry
// it unrecompressed. These tests pin both gates and the two settings behind them.
const require = createRequire(import.meta.url)
const desktopRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(desktopRoot, '../..')
const ENGINE = 'APEX.app/Contents/Resources/bundled-runtime/runtime-bundle-7ae7a5617dfd-mac-arm64.tar.gz'

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hc1058-${label}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function noise(seed, length) {
  const out = Buffer.alloc(length)
  for (let at = 0, n = 0; at < length; n++) at += createHash('sha256').update(`${seed}:${n}`).digest().copy(out, at)
  return out
}

// A minimal zip writer: method 0 stores, method 8 deflates.
function writeZip(file, entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, method } of entries) {
    const body = method === 8 ? zlib.deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const common = Buffer.alloc(26)
    common.writeUInt16LE(20, 0); common.writeUInt16LE(0, 2); common.writeUInt16LE(method, 4)
    common.writeUInt32LE(zlib.crc32(data), 10); common.writeUInt32LE(body.length, 14); common.writeUInt32LE(data.length, 18)
    common.writeUInt16LE(nameBytes.length, 22)
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), common, nameBytes, body])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4)
    common.copy(central, 6, 0, 26); central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBytes]))
    locals.push(local)
    offset += local.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]))
}

test('mac-zip accepts a stored engine entry and rejects a deflated, missing or doubled one', t => {
  const dir = tempDir(t, 'zip')
  const engine = zlib.gzipSync(noise('engine', 200_000))
  const plist = Buffer.from('<plist/>'.repeat(500))
  const zip = (name, entries) => { const file = path.join(dir, name); writeZip(file, entries); return file }

  const stored = zip('stored.zip', [{ name: 'APEX.app/Contents/Info.plist', data: plist, method: 8 }, { name: ENGINE, data: engine, method: 0 }])
  assert.deepEqual(readZipEntries(stored).map(entry => [entry.name, entry.method]), [['APEX.app/Contents/Info.plist', 8], [ENGINE, 0]])
  assert.equal(assertMacUpdateZipStoresEngine(stored).size, engine.length)

  const deflated = zip('deflated.zip', [{ name: ENGINE, data: engine, method: 8 }])
  assert.throws(() => assertMacUpdateZipStoresEngine(deflated), /is compressed \(method 8\).*ZIPOPT/)
  assert.throws(() => assertMacUpdateZipStoresEngine(zip('none.zip', [{ name: 'APEX.app/Contents/Info.plist', data: plist, method: 8 }])), /found 0/)
  const twice = zip('twice.zip', [{ name: ENGINE, data: engine, method: 0 }, { name: ENGINE.replace('7ae7a5617dfd', 'a2e1a4b57422'), data: engine, method: 0 }])
  assert.throws(() => assertMacUpdateZipStoresEngine(twice), /found 2/)
})

test('Info-ZIP stores the engine only with the ZIPOPT afterPack sets, and still deflates the rest', t => {
  const probe = spawnSync('zip', ['-v'], { encoding: 'utf8' })
  if (probe.status !== 0 || !/Info-ZIP/.test(probe.stdout)) return t.skip('Info-ZIP zip is not installed here')
  const dir = tempDir(t, 'infozip')
  const engine = path.join(dir, ...ENGINE.split('/'))
  fs.mkdirSync(path.dirname(engine), { recursive: true })
  fs.writeFileSync(engine, zlib.gzipSync(noise('engine', 300_000)))
  fs.writeFileSync(path.join(dir, 'APEX.app', 'Contents', 'Info.plist'), '<plist/>'.repeat(5_000))
  // electron-builder 26 on macOS: `zip -q -r -y -7 <out> APEX.app` (app-builder-lib archive.js).
  const pack = (name, env) => {
    const out = path.join(dir, name)
    const result = spawnSync('zip', ['-q', '-r', '-y', '-7', out, 'APEX.app'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return out
  }
  const { ZIPOPT: _unused, ...plain } = process.env
  assert.throws(() => assertMacUpdateZipStoresEngine(pack('plain.zip', plain)), /is compressed/)
  const env = { ...plain }
  assert.equal(storeEngineInMacUpdateZip(env), `-n ${MAC_ZIP_STORED_SUFFIXES}`)
  const seamed = pack('seamed.zip', env)
  assertMacUpdateZipStoresEngine(seamed)
  assert.equal(readZipEntries(seamed).find(entry => entry.name.endsWith('Info.plist')).method, 8)
})

test('electron-builder\'s own macOS zip step honours the ZIPOPT afterPack sets', async t => {
  if (process.platform !== 'darwin') return t.skip('electron-builder writes update zips with Info-ZIP only on macOS')
  const { archive } = require('app-builder-lib/out/targets/archive.js')
  const dir = tempDir(t, 'eb-zip')
  const engine = path.join(dir, ...ENGINE.split('/'))
  fs.mkdirSync(path.dirname(engine), { recursive: true })
  fs.writeFileSync(engine, zlib.gzipSync(noise('engine', 300_000)))
  fs.writeFileSync(path.join(dir, 'APEX.app', 'Contents', 'Info.plist'), '<plist/>'.repeat(5_000))
  // The options ArchiveTarget passes for a macOS zip (app-builder-lib 26.15).
  const options = { compression: 'normal', withoutDir: false, preserveSymlinks: true }
  const before = process.env.ZIPOPT
  t.after(() => { if (before === undefined) delete process.env.ZIPOPT; else process.env.ZIPOPT = before })
  delete process.env.ZIPOPT
  await archive('zip', path.join(dir, 'plain.zip'), path.join(dir, 'APEX.app'), options)
  assert.throws(() => assertMacUpdateZipStoresEngine(path.join(dir, 'plain.zip')), /is compressed/)
  storeEngineInMacUpdateZip(process.env)
  await archive('zip', path.join(dir, 'seamed.zip'), path.join(dir, 'APEX.app'), options)
  assert.equal(assertMacUpdateZipStoresEngine(path.join(dir, 'seamed.zip')).name, ENGINE)
})

test('the stored-suffix list keeps Info-ZIP\'s own defaults and adds gzip', () => {
  assert.deepEqual(MAC_ZIP_STORED_SUFFIXES.split(':'), ['.Z', '.zip', '.zoo', '.arc', '.lzh', '.arj', '.gz'])
})

function windowsApp(dir, archive) {
  const runtime = path.join(dir, 'win-unpacked', 'resources', 'bundled-runtime')
  fs.mkdirSync(runtime, { recursive: true })
  fs.writeFileSync(path.join(runtime, 'runtime-bundle-7ae7a5617dfd-win-x64.tar.gz'), archive)
  fs.writeFileSync(path.join(runtime, 'manifest.json'), '{}')
  return path.join(dir, 'win-unpacked')
}

test('nsis accepts an installer that carries the engine archive verbatim', t => {
  const dir = tempDir(t, 'nsis')
  const archive = zlib.gzipSync(noise('engine', 2 * 1024 * 1024))
  const appDir = windowsApp(dir, archive)
  const installer = path.join(dir, 'APEX-0.17.64-win-x64.exe')
  const prefix = noise('nsis-stub-and-7z', 700_000)
  fs.writeFileSync(installer, Buffer.concat([prefix, archive, noise('uninstaller', 50_000)]))
  assert.deepEqual(assertNsisInstallerStoresEngine(installer, appDir),
    { archive: 'runtime-bundle-7ae7a5617dfd-win-x64.tar.gz', offset: prefix.length, size: archive.length })
})

test('nsis rejects an installer whose engine archive was recompressed or cut short', t => {
  const dir = tempDir(t, 'nsis-bad')
  const archive = zlib.gzipSync(noise('engine', 2 * 1024 * 1024))
  const appDir = windowsApp(dir, archive)
  const installer = path.join(dir, 'APEX-0.17.64-win-x64.exe')
  fs.writeFileSync(installer, Buffer.concat([noise('stub', 1000), zlib.deflateRawSync(archive)]))
  assert.throws(() => assertNsisInstallerStoresEngine(installer, appDir), /not stored verbatim/)
  fs.writeFileSync(installer, Buffer.concat([noise('stub', 1000), archive.subarray(0, archive.length - 1)]))
  assert.throws(() => assertNsisInstallerStoresEngine(installer, appDir), /not stored verbatim/)
})

test('nsis fails on any .tar.gz electron-builder would exclude from the 7z without re-adding', t => {
  const dir = tempDir(t, 'nsis-dropped')
  const archive = zlib.gzipSync(noise('engine', 4096))
  const appDir = windowsApp(dir, archive)
  for (const rel of ['resources/app.asar.unpacked/node_modules/pkg/data.tar.gz', 'locales/extra.tar.gz', 'resources/assets/ok.tar.gz']) {
    fs.mkdirSync(path.dirname(path.join(appDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(appDir, rel), archive)
  }
  assert.deepEqual(nsisDroppedArchives(appDir), ['locales/extra.tar.gz', 'resources/app.asar.unpacked/node_modules/pkg/data.tar.gz'])
  fs.writeFileSync(path.join(dir, 'APEX.exe'), archive)
  assert.throws(() => assertNsisInstallerStoresEngine(path.join(dir, 'APEX.exe'), appDir), /would drop these \.tar\.gz files/)
})

test('package.json keeps electron-builder\'s pre-compressed list and adds the engine archive', () => {
  const ours = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')).build.nsis.preCompressedFileExtensions
  const nsisTarget = fs.readFileSync(require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8')
  const defaults = JSON.parse(/preCompressedFileExtensions: (\[[^\]]+\])/.exec(nsisTarget)[1])
  assert.deepEqual(ours, [...defaults, '.tar.gz'])
})

test('both platform workflows gate the shipped package after building it', () => {
  const yaml = require('js-yaml')
  const steps = workflow => Object.values(yaml.load(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', workflow), 'utf8')).jobs)
    .flatMap(job => job.steps || [])
  const order = (workflow, build, gate, upload) => {
    const names = steps(workflow).map(step => step.name || '')
    const runs = steps(workflow).map(step => step.run || '')
    const at = runs.findIndex(text => text.includes(gate))
    assert.ok(at > names.findIndex(name => name.startsWith(build)), `${workflow}: gate after ${build}`)
    assert.ok(at < names.findIndex(name => name === upload), `${workflow}: gate before ${upload}`)
  }
  order('desktop-macos.yml', 'Build, sign and notarize', 'node scripts/assert-update-engine-stored.mjs mac-zip "$ZIP"', 'Upload installer artifact')
  order('desktop-windows.yml', 'Build Windows installer', 'node scripts/assert-update-engine-stored.mjs nsis (Get-Item release/APEX-*-win-x64.exe).FullName release/win-unpacked', 'Upload installer artifact')
})
