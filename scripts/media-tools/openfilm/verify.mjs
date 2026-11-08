// Verifies the OpenFilm patches pinned here (hc-1175, hc-1176) before an OpenFilm toolkit is built with them:
//   1. fetches the pinned openfilm package and its pinned dependencies (each checked against its integrity), and the
//      upstream source at the pinned commit;
//   2. checks that every file a patch touches is the same in both, so upstream's tests run the code that ships;
//   3. applies the patches to both (each must apply cleanly, with no rejects);
//   4. runs the guards (pin.json guards) on the patched package, the reverse check (each part of the patches taken
//      out turns a guard red), and upstream's own tests of what the patches touch on the patched source.
// Leaves the patched package in <work>/npm/package with its dependencies in <work>/npm/node_modules (the toolkit's
// files: build_toolkit.py packs them). Writes only under the work folder, which must be empty. Needs node, git, tar
// and patch.
//   node scripts/media-tools/openfilm/verify.mjs <empty work folder>
// APEX_NPM_REGISTRY replaces the npm registry in the pinned tarball links (integrity is checked all the same).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pin = JSON.parse(readFileSync(join(here, 'pin.json'), 'utf8'))
const work = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'usage: node verify.mjs <empty work folder>')
mkdirSync(work, { recursive: true })
assert.equal(readdirSync(work).length, 0, `${work} is not empty`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (${result.status ?? result.signal})`)
}

/** A pinned npm tarball, checked against its integrity, unpacked into `into` (its files under `package/`). */
async function npmPackage({ tarball, integrity }, into) {
  const registry = process.env.APEX_NPM_REGISTRY
  const url = registry ? tarball.replace('https://registry.npmjs.org', registry.replace(/\/$/, '')) : tarball
  const response = await fetch(url)
  assert.ok(response.ok, `${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const [algorithm, digest] = integrity.split(/-(.*)/s)
  assert.equal(
    createHash(algorithm).update(bytes).digest('base64'),
    digest,
    `${url} does not match its pinned integrity`
  )
  mkdirSync(into, { recursive: true })
  const file = join(into, 'package.tgz')
  writeFileSync(file, bytes)
  run('tar', ['-xzf', file, '-C', into])
  return join(into, 'package')
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
/** The files a patch changes, by their path in the package. */
const touched = patch => [...readFileSync(patch, 'utf8').matchAll(/^\+\+\+ b\/(\S+)$/gm)].map(m => m[1])

const pkg = await npmPackage(pin.package, join(work, 'npm'))
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
assert.equal(version, pin.package.version, `the package is openfilm ${version}, not ${pin.package.version}`)

const checkout = join(work, 'source')
mkdirSync(checkout)
run('git', ['init', '--quiet', checkout])
run('git', ['-C', checkout, 'fetch', '--quiet', '--depth', '1', pin.source.repository, pin.source.commit])
run('git', ['-C', checkout, 'checkout', '--quiet', 'FETCH_HEAD'])
const head = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
assert.equal(head, pin.source.commit, 'the source is not at the pinned commit')
const source = join(checkout, pin.source.packageDir)

const patches = pin.patches.map(p => join(here, p))
for (const patch of patches) {
  for (const file of touched(patch)) {
    assert.equal(
      sha256(join(pkg, file)),
      sha256(join(source, file)),
      `${file} differs between the npm package and the source at ${pin.source.tag}`
    )
  }
}
for (const dir of [pkg, source]) {
  for (const patch of patches) {
    run('patch', ['-p1', '--forward', '--batch', '--dry-run', '-d', dir, '-i', patch], {
      stdio: ['ignore', 'ignore', 'inherit']
    })
    run('patch', ['-p1', '--forward', '--batch', '-d', dir, '-i', patch], { stdio: ['ignore', 'ignore', 'inherit'] })
  }
  const leftovers = readdirSync(dir, { recursive: true }).filter(f => /\.(rej|orig)$/.test(String(f)))
  assert.deepEqual(leftovers, [], `a patch left rejects or backups in ${dir}`)
}
console.log(`patched openfilm ${version} (npm package and ${pin.source.tag} source) with ${patches.length} patch(es)`)

/* openfilm's dependencies, pinned too (the version it asks for): beside the package, as the toolkit has them, and in
   the source */
const wanted = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).dependencies ?? {}
assert.deepEqual(
  Object.keys(pin.dependencies).sort(),
  Object.keys(wanted).sort(),
  'pin.json pins other dependencies than openfilm has'
)
for (const [name, dep] of Object.entries(pin.dependencies)) {
  assert.equal(dep.version, wanted[name], `openfilm asks for ${name} ${wanted[name]}, pin.json has ${dep.version}`)
  const unpacked = await npmPackage(dep, join(work, 'deps', name))
  for (const into of [join(work, 'npm', 'node_modules'), join(source, 'node_modules')]) {
    mkdirSync(into, { recursive: true })
    cpSync(unpacked, join(into, name), { recursive: true })
  }
}

const env = { ...process.env, OPENFILM_PACKAGE: pkg, OPENFILM_NO_BROWSER: '1', OPENFILM_NO_UPDATE_CHECK: '1' }
run(process.execPath, ['--test', ...pin.guards.map(g => join(here, g))], { env })
run(process.execPath, [join(here, 'reverse-verify.mjs')], { env })

/* upstream's tests of what the patches touch, on the patched source */
for (const test of pin.upstreamTests) assert.ok(existsSync(join(source, test)), `${test} is not in the source`)
/* (no browsers: these tests must not need one) */
run(process.execPath, ['--test', '--test-concurrency=1', ...pin.upstreamTests], {
  cwd: source,
  env: { ...env, OPENFILM_HOME: join(work, 'home'), PLAYWRIGHT_BROWSERS_PATH: join(work, 'no-browsers') }
})
console.log('the patches are verified')
