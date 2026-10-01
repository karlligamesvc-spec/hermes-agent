import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnedRuntimeTree } from '../../../scripts/runtime-bundle-offline-smoke.mjs'

assert.equal(process.platform, 'win32', 'The executable-lock gate requires real native Windows')
const args = process.argv.slice(2)
assert.equal(args[0], '--proof', 'Usage: node runtime-bundle-owned-cleanup-gate.mjs --proof FILE')
assert.ok(args[1])
const proofPath = path.resolve(args[1])
const helperPath = fileURLToPath(new URL('../../../scripts/runtime-bundle-offline-smoke.mjs', import.meta.url))
const testPath = fileURLToPath(new URL('./runtime-bundle-offline-smoke.node-test.mjs', import.meta.url))
const helper = fs.readFileSync(helperPath)
const tests = fs.readFileSync(testPath)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-owned-tree-reversal-'))
const proof = { nativePlatform: process.platform, helperSha256: digest(helper), testSha256: digest(tests), success: false }

function runFocused(file, name) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...(name ? [`--test-name-pattern=${name}`] : []), file], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.equal(result.error, undefined, 'native test process must finish within its budget')
  return result
}

try {
  const positive = runFocused(testPath)
  assert.equal(positive.status, 0, 'all original native focused tests must pass before reversal')
  assert.match(positive.stdout, /# fail 0\b/)
  assert.match(positive.stdout, /# skipped 0\b/, 'Windows locking test cannot be skipped')
  const anchor = "['/PID', String(child.pid), '/T', '/F']"
  const source = helper.toString('utf8')
  assert.equal(source.split(anchor).length - 1, 1, 'tree-kill executable anchor must be unique')
  const modified = source.replace(anchor, "['/PID', String(child.pid), '/F']")
  const copiedHelper = path.join(workspace, 'helper-without-tree-kill.mjs')
  const copiedTests = path.join(workspace, 'owned-lock-test.mjs')
  fs.writeFileSync(copiedHelper, modified)
  assert.equal(fs.readFileSync(copiedHelper, 'utf8'), modified, 'mutation must land in the exact private file')
  assert.notEqual(digest(fs.readFileSync(copiedHelper)), digest(helper))
  const importAnchor = "'../../../scripts/runtime-bundle-offline-smoke.mjs'"
  const testSource = tests.toString('utf8')
  assert.equal(testSource.split(importAnchor).length - 1, 1, 'private test import must be unique')
  fs.writeFileSync(copiedTests, testSource.replace(importAnchor, JSON.stringify(pathToFileURL(copiedHelper).href)))
  const negative = runFocused(copiedTests, '^native Windows tree shutdown')
  assert.notEqual(negative.status, 0, 'removing /T must make the native executable-lock guard fail')
  assert.match(negative.stdout, /not ok \d+ - native Windows tree shutdown/)
  assert.match(negative.stdout, /# fail 1\b/)
  assert.match(negative.stdout, /Owned smoke process \d+ did not close within 5 seconds/)
  assert.match(negative.stdout, /"recordedFixturesRetired":true/)
  assert.match(negative.stdout, /"privateFixtureRemoved":true/)
  assert.doesNotMatch(negative.stdout + negative.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/)
  proof.reversal = { anchorCount: 1, privateHelperSha256: digest(fs.readFileSync(copiedHelper)), privateTestSha256: digest(fs.readFileSync(copiedTests)), exitCode: negative.status, actualOwnedDescendantFailure: true }
  assert.equal(digest(fs.readFileSync(helperPath)), proof.helperSha256, 'checkout helper must remain unchanged')
  assert.equal(digest(fs.readFileSync(testPath)), proof.testSha256, 'checkout tests must remain unchanged')
  const restored = runFocused(testPath, '^native Windows tree shutdown')
  assert.equal(restored.status, 0, 'unmodified tree-kill implementation must pass after the private reversal')
  assert.match(restored.stdout, /# fail 0\b/)
  proof.success = true
} finally {
  removeOwnedRuntimeTree(workspace)
  assert.equal(fs.existsSync(workspace), false)
  proof.privateCopyRemoved = true
  proof.checkoutHelperUnchanged = digest(fs.readFileSync(helperPath)) === proof.helperSha256
  proof.checkoutTestUnchanged = digest(fs.readFileSync(testPath)) === proof.testSha256
  assert.ok(proof.checkoutHelperUnchanged && proof.checkoutTestUnchanged)
  fs.mkdirSync(path.dirname(proofPath), { recursive: true })
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n')
}
console.log(JSON.stringify(proof))
