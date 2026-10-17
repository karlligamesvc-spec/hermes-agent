// Exercise the runtime bundle's exact install command with an empty npm cache.
// This loopback registry serves only the prepared, hash-checked dependency slice.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function loadMirror(root, lockFile) {
  const bytes = fs.readFileSync(lockFile)
  const lock = JSON.parse(bytes)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mirror.json')))
  assert.equal(manifest.lockSha256, createHash('sha256').update(bytes).digest('hex'), 'mirror must match the source lock')
  assert.equal(manifest.prefix, `media-tools/npm/${manifest.lockSha256}`)
  const expected = new Map()
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!location) continue
    expected.set(`${location.split('node_modules/').at(-1)}@${pkg.version}`, pkg.integrity)
  }
  const routes = new Map()
  const names = new Set([...expected.keys()].map(key => key.slice(0, key.lastIndexOf('@'))))
  const optionalPeers = new Set()
  const required = new Set()
  let versions = 0
  for (const name of names) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, name)))
    assert.equal(metadata.name, name)
    for (const [version, pkg] of Object.entries(metadata.versions)) {
      assert.equal(pkg.name, name)
      assert.equal(pkg.version, version)
      assert.equal(pkg.dist.integrity, expected.get(`${name}@${version}`), 'unexpected package or integrity')
      for (const dependency of Object.keys(pkg.dependencies || {})) required.add(dependency)
      for (const peer of Object.keys(pkg.peerDependencies || {})) {
        if (pkg.peerDependenciesMeta?.[peer]?.optional === true) optionalPeers.add(peer)
        else required.add(peer)
      }
      const prefix = `${manifest.registry}/tarballs/`
      assert.ok(pkg.dist.tarball.startsWith(prefix), 'tarball must belong to this immutable mirror')
      const filename = pkg.dist.tarball.slice(prefix.length)
      assert.match(filename, /^[a-f0-9]{64}\.tgz$/)
      const payload = fs.readFileSync(path.join(root, 'tarballs', filename))
      assert.equal(createHash('sha256').update(payload).digest('hex'), filename.slice(0, -4))
      const [algorithm, encoded] = pkg.dist.integrity.split('-')
      assert.equal(createHash(algorithm).update(payload).digest('base64'), encoded)
      routes.set(`/tarballs/${filename}`, payload)
      versions++
    }
    routes.set(`/${name}`, metadata)
  }
  assert.equal(versions, expected.size, 'all locked packages must have metadata')
  assert.equal(versions, manifest.versions)
  assert.equal(names.size, manifest.packages)
  const absentOptionalPeers = new Set([...optionalPeers].filter(name => !names.has(name) && !required.has(name)))
  return { manifest, routes, absentOptionalPeers, version: lock.packages[''].dependencies['@hypit/hypit'] }
}

export async function startRegistry(mirror) {
  const requests = []
  let origin
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
    let route
    try { route = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname) }
    catch { res.writeHead(400).end(); return }
    const data = mirror.routes.get(route)
    requests.push({ route, found: !!data, optionalPeer: !data && mirror.absentOptionalPeers.has(route.slice(1)) })
    if (!data) { res.writeHead(404).end(); return }
    let body = data
    if (!Buffer.isBuffer(data)) {
      const metadata = structuredClone(data)
      for (const pkg of Object.values(metadata.versions)) {
        pkg.dist.tarball = origin + new URL(pkg.dist.tarball).pathname.slice(`/${mirror.manifest.prefix}`.length)
      }
      body = Buffer.from(JSON.stringify(metadata))
    }
    res.writeHead(200, { 'content-length': body.length, 'content-type': Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json' })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  return { origin, requests, close: () => new Promise(resolve => server.close(resolve)) }
}

async function run(args, cwd, env, log) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = fs.createWriteStream(log, { flags: 'a' })
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
  const timer = setTimeout(() => child.kill(), 180000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, 0, 'native npm or Hypit CLI failed; see smoke.log')
  } finally { clearTimeout(timer); output.end() }
}

async function main() {
  const [root, destination] = process.argv.slice(2)
  assert.ok(root && destination && process.argv.length === 4, 'Usage: node registry-install-smoke.mjs MIRROR NEW_WORKSPACE')
  const lockFile = fileURLToPath(new URL('./hypit-runtime/package-lock.json', import.meta.url))
  const mirror = loadMirror(root, lockFile)
  const work = path.resolve(destination)
  fs.mkdirSync(work, { recursive: false })
  fs.mkdirSync(path.join(work, 'home'))
  fs.writeFileSync(path.join(work, 'npmrc-user'), '')
  fs.writeFileSync(path.join(work, 'npmrc-global'), '')
  const runtime = path.join(work, 'hypit')
  const log = path.join(work, 'smoke.log')
  const registry = await startRegistry(mirror)
  const proof = { success: false, platform: process.platform, arch: process.arch, version: mirror.version,
    lockSha256: mirror.manifest.lockSha256, emptyCache: true, mode: 'loopback-prepared-mirror', cosReadback: false }
  try {
    const nodeRoot = path.dirname(process.execPath)
    const npmCli = process.platform === 'win32' ? path.join(nodeRoot, 'node_modules/npm/bin/npm-cli.js') : path.join(nodeRoot, '../lib/node_modules/npm/bin/npm-cli.js')
    const env = { PATH: [nodeRoot, '/usr/bin', '/bin'].join(path.delimiter), HOME: path.join(work, 'home'),
      USERPROFILE: path.join(work, 'home'), TMPDIR: work, TEMP: work, TMP: work,
      npm_config_cache: path.join(work, 'cache'), npm_config_userconfig: path.join(work, 'npmrc-user'),
      npm_config_globalconfig: path.join(work, 'npmrc-global'), npm_config_update_notifier: 'false' }
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    await run([npmCli, 'install', '--prefix', runtime, '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry', registry.origin, `@hypit/hypit@${mirror.version}`], work, env, log)
    const installed = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/@hypit/hypit/package.json')))
    assert.equal(installed.version, mirror.version)
    await run([path.join(runtime, 'node_modules/@hypit/hypit/bin/hypit.mjs'), '--version'], work, env, log)
    assert.ok(registry.requests.some(r => r.route.startsWith('/tarballs/')), 'install must fetch tarballs from the prepared mirror')
    assert.ok(registry.requests.every(r => r.found || r.optionalPeer), 'install requested an unmirrored required package')
    proof.success = true
  } catch (error) { proof.error = error.message; process.exitCode = 1 }
  finally {
    await registry.close()
    proof.requests = registry.requests
    fs.writeFileSync(path.join(work, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    console.log(JSON.stringify({ ...proof, requests: proof.requests.length }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
