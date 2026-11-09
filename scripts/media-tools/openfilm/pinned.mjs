// What verify.mjs and editor/verify-editor.mjs share: run a command (it must succeed), and fetch a pinned npm tarball
// (checked against its integrity before it is unpacked).
// APEX_NPM_REGISTRY replaces the npm registry in the pinned tarball links (integrity is checked all the same).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (${result.status ?? result.signal})`)
}

/** A pinned npm tarball, checked against its integrity, unpacked into `into` (its files under `package/`). */
export async function npmPackage({ tarball, integrity }, into) {
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

export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
