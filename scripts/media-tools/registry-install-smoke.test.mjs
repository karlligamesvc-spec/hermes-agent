import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadMirror, startRegistry } from './registry-install-smoke.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-registry-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const payload = Buffer.from('fixture package bytes')
  const integrity = 'sha512-' + createHash('sha512').update(payload).digest('base64')
  const digest = createHash('sha256').update(payload).digest('hex')
  const lock = { packages: { '': { dependencies: { '@hypit/hypit': '0.3.1' } },
    'node_modules/@hypit/hypit': { version: '0.3.1', integrity } } }
  const lockFile = path.join(root, 'lock.json')
  fs.writeFileSync(lockFile, JSON.stringify(lock))
  const lockSha256 = createHash('sha256').update(fs.readFileSync(lockFile)).digest('hex')
  const prefix = `media-tools/npm/${lockSha256}`
  const registry = `https://example.invalid/${prefix}`
  const metadata = { name: '@hypit/hypit', versions: { '0.3.1': { name: '@hypit/hypit', version: '0.3.1',
    dist: { integrity, tarball: `${registry}/tarballs/${digest}.tgz` } } } }
  fs.mkdirSync(path.join(root, '@hypit')); fs.mkdirSync(path.join(root, 'tarballs'))
  const metadataFile = path.join(root, '@hypit/hypit')
  fs.writeFileSync(metadataFile, JSON.stringify(metadata))
  fs.writeFileSync(path.join(root, 'tarballs', digest + '.tgz'), payload)
  fs.writeFileSync(path.join(root, 'mirror.json'), JSON.stringify({ lockSha256, prefix, registry, versions: 1, packages: 1 }))
  return { root, lockFile, metadata, metadataFile, digest, payload }
}

test('loopback serves encoded scoped metadata and only the verified tarball, without changing source metadata', async t => {
  const f = fixture(t)
  const original = fs.readFileSync(f.metadataFile)
  const mirror = loadMirror(f.root, f.lockFile)
  const server = await startRegistry(mirror)
  t.after(() => server.close())
  const pkg = await (await fetch(`${server.origin}/@hypit%2Fhypit`)).json()
  const url = pkg.versions['0.3.1'].dist.tarball
  assert.equal(url, `${server.origin}/tarballs/${f.digest}.tgz`)
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), f.payload)
  assert.equal((await fetch(`${server.origin}/lock.json`)).status, 404)
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  assert.deepEqual(fs.readFileSync(f.metadataFile), original)
})

test('a self-consistent replacement tarball still fails the independent npm integrity check', t => {
  const f = fixture(t)
  const replacement = Buffer.from('different package bytes')
  const digest = createHash('sha256').update(replacement).digest('hex')
  fs.writeFileSync(path.join(f.root, 'tarballs', digest + '.tgz'), replacement)
  f.metadata.versions['0.3.1'].dist.tarball = f.metadata.versions['0.3.1'].dist.tarball.replace(f.digest, digest)
  fs.writeFileSync(f.metadataFile, JSON.stringify(f.metadata))
  assert.throws(() => loadMirror(f.root, f.lockFile), { code: 'ERR_ASSERTION' })
})

test('wrong source lock and missing locked package fail before an npm process can start', t => {
  const f = fixture(t)
  fs.appendFileSync(f.lockFile, '\n')
  assert.throws(() => loadMirror(f.root, f.lockFile), /mirror must match the source lock/)
  fs.writeFileSync(f.lockFile, fs.readFileSync(f.lockFile, 'utf8').trimEnd())
  f.metadata.versions = {}
  fs.writeFileSync(f.metadataFile, JSON.stringify(f.metadata))
  assert.throws(() => loadMirror(f.root, f.lockFile), /all locked packages must have metadata/)
})

test('a foreign tarball or path outside the content-addressed inventory is rejected', t => {
  const f = fixture(t)
  for (const url of ['https://registry.npmjs.org/unmirrored.tgz', 'https://example.invalid/../../secrets.tgz']) {
    f.metadata.versions['0.3.1'].dist.tarball = url
    fs.writeFileSync(f.metadataFile, JSON.stringify(f.metadata))
    assert.throws(() => loadMirror(f.root, f.lockFile), /this immutable mirror/)
  }
})

test('only declared optional peers may be absent; required dependency use overrides an optional declaration', async t => {
  const f = fixture(t)
  const pkg = f.metadata.versions['0.3.1']
  pkg.peerDependencies = { optional: '>=1', required: '>=1', mixed: '>=1' }
  pkg.peerDependenciesMeta = { optional: { optional: true }, mixed: { optional: true } }
  pkg.dependencies = { mixed: '>=1' }
  fs.writeFileSync(f.metadataFile, JSON.stringify(f.metadata))
  const mirror = loadMirror(f.root, f.lockFile)
  assert.deepEqual([...mirror.absentOptionalPeers], ['optional'])
  const server = await startRegistry(mirror)
  t.after(() => server.close())
  for (const name of ['optional', 'required', 'mixed', 'unknown']) {
    assert.equal((await fetch(`${server.origin}/${name}`)).status, 404)
  }
  assert.deepEqual(server.requests.map(r => r.optionalPeer), [true, false, false, false])
})
