// hc-1233: the portable Node a runtime bundle ships. v0.23.0 pins Node 26 in pm/lock.json and its root engines
// (which the bundle's TUI build enforces through scripts/build/node-deps.mjs) refuse anything older, so a bundle
// that kept staging the newest Node 22 stopped mid-build.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundleNodeVersion } from '../../../scripts/build-runtime-bundle.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const semver = createRequire(import.meta.url)('semver')
// nodejs.org/dist/index.json lists the newest release first.
const DIST_INDEX = [{ version: 'v26.13.1' }, { version: 'v26.12.1' }, { version: 'v22.23.5' }, { version: 'v22.23.4' }]

test('a bundle stages exactly the Node its runtime pins in pm/lock.json', () => {
  assert.equal(bundleNodeVersion('26.12.1', DIST_INDEX), 'v26.12.1')
  assert.equal(bundleNodeVersion('v26.12.1'), 'v26.12.1')
})

test('a runtime without pm/lock.json keeps the newest Node 22 in the dist index', () => {
  assert.equal(bundleNodeVersion(null, DIST_INDEX), 'v22.23.5')
  assert.throws(() => bundleNodeVersion(null, [{ version: 'v26.13.1' }]), /no v22\.x release/)
})

test("this runtime's pinned Node satisfies the root engines its TUI build enforces", () => {
  const pinned = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pm', 'lock.json'), 'utf8')).packages.node.version
  const engines = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node
  assert.ok(semver.satisfies(pinned, engines),
    `pm/lock.json pins Node ${pinned}, outside the root engines "${engines}": the bundle's TUI build stops`)
  assert.equal(bundleNodeVersion(pinned, DIST_INDEX), `v${pinned}`)
})
