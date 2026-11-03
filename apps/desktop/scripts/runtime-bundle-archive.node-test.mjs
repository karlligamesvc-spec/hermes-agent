import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'

import { ARCHIVE_MTIME, writeRuntimeArchive } from '../../../scripts/runtime-bundle-archive.mjs'

// hc-1058: the engine archive inside the shell must be byte-stable for an unchanged
// tree and must change only locally when a few files change, or electron-updater's
// block diff re-downloads the whole engine every release. These tests pin both,
// plus that every tar the shell and the release gates use still extracts it.
const require = createRequire(import.meta.url)
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder')
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const POSIX = process.platform !== 'win32'
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

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

// Compressible like real code (incompressible data is deflated into stored blocks,
// whose raw bytes would let even a single gzip stream resynchronise).
const text = (seed, length) => Buffer.from(noise(seed, length / 2).toString('hex'))

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// Over 100 bytes but splittable into ustar prefix/name; over 255 bytes (pax path only).
const SPLIT_PATH = `venv/lib/python3.14/site-packages/${'a'.repeat(60)}/${'b'.repeat(60)}/mod.py`
const PAX_PATH = `x/${'c'.repeat(120)}/${'d'.repeat(120)}/e.py`
const LONG_LINK = `../${'f'.repeat(120)}`

function engineFiles() {
  return {
    '.hermes-source-commit': 'a2e1a4b574225c0a29087a2102c54c62c97b629a\n',
    '.bundle-manifest.json': '{"schema":1}\n',
    '.runtime/bin/uv': noise('uv', 70_000),
    'hermes_cli/main.py': 'print(1)\n',
    [SPLIT_PATH]: 'x = 1\n',
    [PAX_PATH]: 'y = 2\n',
    'docs/日本語.md': 'unicode\n'
  }
}

function writeEngineTree(root, { reverse = false, mtime = new Date('2020-01-01T00:00:00Z') } = {}) {
  const files = Object.entries(engineFiles())
  for (const [rel, data] of reverse ? files.reverse() : files) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
    fs.chmodSync(abs, rel === '.runtime/bin/uv' ? 0o755 : 0o644)
  }
  fs.mkdirSync(path.join(root, 'empty', 'dir'), { recursive: true })
  if (POSIX) {
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true })
    fs.symlinkSync('../../.runtime/bin/uv', path.join(root, 'venv', 'bin', 'python'))
    fs.symlinkSync(LONG_LINK, path.join(root, 'venv', 'bin', 'long'))
  }
  for (const rel of Object.keys(engineFiles())) fs.utimesSync(path.join(root, ...rel.split('/')), mtime, mtime)
}

// Every header of the (gunzipped) tar: resolved name (pax path / prefix / name), type, mode, mtime, owner.
function tarHeaders(tarBytes) {
  const headers = []
  let pax = {}
  for (let at = 0; at + 512 <= tarBytes.length;) {
    const block = tarBytes.subarray(at, at + 512)
    if (block.every(byte => byte === 0)) break
    const field = (start, length) => block.toString('utf8', start, start + length).replace(/\0.*$/s, '')
    const size = Number.parseInt(field(124, 12), 8)
    const type = field(156, 1)
    const body = tarBytes.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      for (const record of body.toString('utf8').split('\n').filter(Boolean)) {
        const [key, ...value] = record.slice(record.indexOf(' ') + 1).split('=')
        pax[key] = value.join('=')
      }
      continue
    }
    const prefix = field(345, 155)
    headers.push({
      name: pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)),
      linkname: pax.linkpath ?? field(157, 100),
      type,
      mode: Number.parseInt(field(100, 8), 8),
      mtime: Number.parseInt(field(136, 12), 8),
      uid: Number.parseInt(field(108, 8), 8),
      gid: Number.parseInt(field(116, 8), 8),
      owner: field(265, 32) + field(297, 32)
    })
    pax = {}
  }
  return headers
}

function blockDiff(oldFile, newFile) {
  const map = file => {
    const out = `${file}.blockmap`
    return buildBlockMap(file, 'gzip', out).then(() => JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString()))
  }
  return Promise.all([map(oldFile), map(newFile)]).then(([before, after]) => {
    const ops = computeOperations(before, after, { info() {}, warn() {}, error() {}, debug() {} })
    const download = ops.filter(op => op.kind === OperationKind.DOWNLOAD).reduce((sum, op) => sum + op.end - op.start, 0)
    return download / fs.statSync(newFile).size
  })
}

test('an unchanged tree archives to identical bytes whatever its location, mtimes and creation order', t => {
  const dir = tempDir(t, 'determinism')
  const first = path.join(dir, 'build-1', 'stage')
  const second = path.join(dir, 'other-runner', 'deep', 'stage')
  writeEngineTree(first)
  writeEngineTree(second, { reverse: true, mtime: new Date('2026-10-26T13:00:00Z') })
  writeRuntimeArchive(first, path.join(dir, 'a.tar.gz'))
  writeRuntimeArchive(second, path.join(dir, 'b.tar.gz'))
  assert.equal(
    createHash('sha256').update(fs.readFileSync(path.join(dir, 'a.tar.gz'))).digest('hex'),
    createHash('sha256').update(fs.readFileSync(path.join(dir, 'b.tar.gz'))).digest('hex')
  )
})

test('the system tar extracts files, modes, links, empty dirs and long or unicode names unchanged', t => {
  const dir = tempDir(t, 'extract')
  const stage = path.join(dir, 'stage')
  const out = path.join(dir, 'out')
  const archive = path.join(dir, 'runtime-bundle-test.tar.gz')
  writeEngineTree(stage)
  writeRuntimeArchive(stage, archive)
  fs.mkdirSync(out)
  run(TAR, ['-xzf', archive, '-C', out])
  for (const [rel, data] of Object.entries(engineFiles())) {
    const extracted = path.join(out, ...rel.split('/'))
    assert.deepEqual(fs.readFileSync(extracted), Buffer.from(data), rel)
    if (POSIX) assert.equal(fs.statSync(extracted).mode & 0o777, rel === '.runtime/bin/uv' ? 0o755 : 0o644, rel)
  }
  assert.ok(fs.statSync(path.join(out, 'empty', 'dir')).isDirectory())
  if (POSIX) {
    assert.equal(fs.readlinkSync(path.join(out, 'venv', 'bin', 'python')), '../../.runtime/bin/uv')
    assert.equal(fs.readlinkSync(path.join(out, 'venv', 'bin', 'long')), LONG_LINK)
  }
  // bundled-runtime-package.mjs reads members by their "./" names.
  assert.equal(run(TAR, ['-xOzf', archive, './.hermes-source-commit']).toString(), engineFiles()['.hermes-source-commit'])
  const listed = run(TAR, ['-tzf', archive]).toString().split(/\r?\n/).filter(Boolean)
  assert.ok(listed.includes('./.bundle-manifest.json'), listed.slice(0, 5).join(', '))
})

test('every entry carries the fixed mtime and no owner, in name order with directories first', t => {
  const dir = tempDir(t, 'headers')
  const stage = path.join(dir, 'stage')
  writeEngineTree(stage)
  writeRuntimeArchive(stage, path.join(dir, 'a.tar.gz'))
  const headers = tarHeaders(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'a.tar.gz'))))
  assert.equal(headers[0].name, './')
  assert.ok(headers.some(header => header.name === `./${PAX_PATH}`), 'pax path survives')
  for (const header of headers) {
    assert.deepEqual([header.mtime, header.uid, header.gid, header.owner], [ARCHIVE_MTIME, 0, 0, ''], header.name)
  }
  // The fixed mtime is part of the format: changing it re-downloads every engine once.
  assert.equal(ARCHIVE_MTIME, 946684800)
  // Depth-first, siblings in byte order of their names, each directory before its children.
  const names = headers.map(header => header.name)
  const segments = name => name.replace(/^\.\/?/, '').replace(/\/$/, '').split('/').filter(Boolean)
  const byName = (a, b) => {
    const [left, right] = [segments(a), segments(b)]
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return Buffer.compare(Buffer.from(left[i]), Buffer.from(right[i]))
    }
    return left.length - right.length
  }
  assert.deepEqual(names, [...names].sort(byName))
})

test('the archive is one valid gzip member made of many independently deflated segments', t => {
  const dir = tempDir(t, 'gzip')
  const stage = path.join(dir, 'stage')
  fs.mkdirSync(stage)
  for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(stage, `blob-${String(i).padStart(2, '0')}.bin`), noise(`b${i}`, 96 * 1024))
  const archive = path.join(dir, 'a.tar.gz')
  const written = writeRuntimeArchive(stage, archive)
  assert.equal(written.bytes, fs.statSync(archive).size)
  assert.ok(written.segments > 8, `segments ${written.segments}`)
  assert.equal(zlib.gunzipSync(fs.readFileSync(archive)).length, written.tarBytes)
})

test('a minor engine change re-downloads a small share of the archive; one gzip stream would not', async t => {
  const dir = tempDir(t, 'blockdiff')
  const before = path.join(dir, 'before')
  const after = path.join(dir, 'after')
  for (const root of [before, after]) {
    for (let i = 0; i < 48; i++) {
      const file = path.join(root, 'site-packages', `pkg${String(i).padStart(2, '0')}`, '_native.so')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text(`so${i}`, 128 * 1024))
    }
    fs.writeFileSync(path.join(root, 'version.py'), root === before ? 'V = 1\n' : 'V = 2\n')
  }
  // A re-signed binary (same size, new tail), a removed and an added package.
  const resigned = path.join(after, 'site-packages', 'pkg10', '_native.so')
  const bytes = fs.readFileSync(resigned)
  text('new-signature', 4_300).copy(bytes, bytes.length - 4_300)
  fs.writeFileSync(resigned, bytes)
  fs.rmSync(path.join(after, 'site-packages', 'pkg30'), { recursive: true })
  fs.mkdirSync(path.join(after, 'site-packages', 'pkg48'))
  fs.writeFileSync(path.join(after, 'site-packages', 'pkg48', '_native.so'), text('so48', 128 * 1024))

  writeRuntimeArchive(before, path.join(dir, 'before.tar.gz'))
  writeRuntimeArchive(after, path.join(dir, 'after.tar.gz'))
  const segmented = await blockDiff(path.join(dir, 'before.tar.gz'), path.join(dir, 'after.tar.gz'))
  assert.ok(segmented < 0.1, `segmented archive re-downloads ${(segmented * 100).toFixed(1)}%`)

  // Control: the same two tar streams as one gzip stream each (what `tar -czf` produced).
  for (const name of ['before', 'after']) {
    fs.writeFileSync(path.join(dir, `${name}.stream.tar.gz`), zlib.gzipSync(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${name}.tar.gz`)))))
  }
  const stream = await blockDiff(path.join(dir, 'before.stream.tar.gz'), path.join(dir, 'after.stream.tar.gz'))
  assert.ok(stream > 0.5, `single gzip stream re-downloads ${(stream * 100).toFixed(1)}%`)
})

test('a file linked under several names is stored once and extracts as a hard link', t => {
  if (!POSIX) return t.skip('hard links in the fixture need a POSIX filesystem')
  const dir = tempDir(t, 'hardlink')
  const stage = path.join(dir, 'stage')
  const first = path.join(stage, '.runtime', 'git', 'mingw64', 'bin', 'git.exe')
  const deepName = `${'g'.repeat(70)}/${'h'.repeat(70)}/git-upload-pack.exe`
  fs.mkdirSync(path.dirname(first), { recursive: true })
  fs.writeFileSync(first, noise('git', 300_000))
  for (const rel of ['.runtime/git/mingw64/libexec/git-core/git.exe', `.runtime/git/${deepName}`]) {
    fs.mkdirSync(path.dirname(path.join(stage, ...rel.split('/'))), { recursive: true })
    fs.linkSync(first, path.join(stage, ...rel.split('/')))
  }
  const archive = path.join(dir, 'a.tar.gz')
  writeRuntimeArchive(stage, archive)
  const tarBytes = zlib.gunzipSync(fs.readFileSync(archive))
  assert.ok(tarBytes.length < 600_000, `content stored once (${tarBytes.length} tar bytes)`)
  const links = tarHeaders(tarBytes).filter(header => header.type === '1')
  // The first name in archive order carries the content (here the long one, so
  // both links need a pax linkpath); the others link to it.
  assert.deepEqual(links.map(header => [header.name, header.linkname]), [
    ['./.runtime/git/mingw64/bin/git.exe', `./.runtime/git/${deepName}`],
    ['./.runtime/git/mingw64/libexec/git-core/git.exe', `./.runtime/git/${deepName}`]
  ])
  const out = path.join(dir, 'out')
  fs.mkdirSync(out)
  run(TAR, ['-xzf', archive, '-C', out])
  const extracted = ['.runtime/git/mingw64/bin/git.exe', '.runtime/git/mingw64/libexec/git-core/git.exe', `.runtime/git/${deepName}`]
    .map(rel => path.join(out, ...rel.split('/')))
  for (const file of extracted) assert.deepEqual(fs.readFileSync(file), noise('git', 300_000))
  assert.equal(new Set(extracted.map(file => fs.statSync(file).ino)).size, 1)
})

test('priming each segment keeps the archive within 3% of one gzip stream', t => {
  const dir = tempDir(t, 'ratio')
  const stage = path.join(dir, 'stage')
  // Many small source-like files sharing a header and a vocabulary, like a venv.
  const words = Array.from({ length: 400 }, (_, i) => createHash('sha256').update(`w${i}`).digest('hex').slice(0, 3 + (i % 7)))
  const header = `# Copyright APEX. Licensed under the MIT License.\n${words.slice(0, 120).join(' ')}\n`
  for (let i = 0; i < 600; i++) {
    const lines = [header]
    for (let line = 0; line < 40; line++) {
      const hash = createHash('sha256').update(`${i}:${line}`).digest()
      lines.push(Array.from({ length: 8 }, (_, k) => words[hash[k] + (hash[k + 8] % 2) * 144]).join(' '))
    }
    const file = path.join(stage, `pkg${i % 30}`, `mod${i}.py`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join('\n'))
  }
  const archive = path.join(dir, 'a.tar.gz')
  writeRuntimeArchive(stage, archive)
  const segmented = fs.statSync(archive).size
  const stream = zlib.gzipSync(zlib.gunzipSync(fs.readFileSync(archive))).length
  assert.ok(segmented <= stream * 1.03, `segmented ${segmented} vs one stream ${stream} (${(segmented / stream).toFixed(3)}×)`)
})

test('the bundle builder archives with this writer, not with `tar -czf`', () => {
  const builder = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-runtime-bundle.mjs'), 'utf8')
  assert.match(builder, /import \{ writeRuntimeArchive \} from '\.\/runtime-bundle-archive\.mjs'/)
  assert.match(builder, /const written = writeRuntimeArchive\(stage, archivePath\)/)
  assert.doesNotMatch(builder, /'-czf'/)
})
