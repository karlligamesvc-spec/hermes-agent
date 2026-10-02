import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { machOFileType, verifyNotarizedMacExecutable } from '../../../scripts/mac-runtime-payload.mjs'

test('native payload signing distinguishes Mach-O executables, libraries and fat binaries from Java classes', () => {
  const executable = Buffer.alloc(32)
  executable.writeUInt32BE(0xcffaedfe, 0)
  executable.writeUInt32LE(2, 12)
  const library = Buffer.from(executable)
  library.writeUInt32LE(6, 12)
  const fat = Buffer.alloc(96)
  fat.writeUInt32BE(0xcafebabe, 0)
  fat.writeUInt32BE(1, 4)
  fat.writeUInt32BE(64, 16)
  executable.copy(fat, 64)
  assert.equal(machOFileType(executable), 2)
  assert.equal(machOFileType(library), 6)
  assert.equal(machOFileType(fat), 2)
  const java = Buffer.alloc(32)
  java.writeUInt32BE(0xcafebabe, 0)
  java.writeUInt32BE(61, 4)
  for (const bytes of [java, Buffer.alloc(0), Buffer.alloc(16), Buffer.from('plain source')]) {
    assert.equal(machOFileType(bytes), null)
  }
})

const accepted = { status: 'Accepted', submission_id: 'owned-fixture-submission', issues: [] }

function assessmentFixture(t, results) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-assessment-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const executable = path.join(root, 'owned-tool')
  const fixture = path.join(root, 'codesign-fixture.cjs')
  const state = path.join(root, 'attempt.json')
  fs.writeFileSync(executable, 'owned executable bytes')
  fs.writeFileSync(fixture, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--display')) { console.error('CDHash=${'a'.repeat(40)}'); }
else if (args.includes('--check-notarization')) {
  const state = ${JSON.stringify(state)};
  const index = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : 0;
  const results = ${JSON.stringify(results)};
  const result = results[Math.min(index, results.length - 1)];
  fs.writeFileSync(state, JSON.stringify(index + 1));
  console.error(result.stderr || ''); process.exitCode = result.status;
}
`)
  const calls = []
  const execute = (command, args, options) => {
    calls.push(args)
    assert.equal(command, '/usr/bin/codesign')
    assert.equal(options.timeout, 30000)
    assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(options.shell, false)
    return spawnSync(process.execPath, [fixture, ...args], options)
  }
  return { executable, calls, execute }
}

const requirementFailure = { status: 3, stderr: 'test-requirement: code failed to satisfy specified code requirement(s)' }

test('Accepted same-byte executable retries a real fixture requirement failure and verifies the second assessment', async t => {
  const fixture = assessmentFixture(t, [requirementFailure, { status: 0 }])
  const delays = []
  const receipt = await verifyNotarizedMacExecutable(fixture.executable, accepted, { execute: fixture.execute, wait: async delay => delays.push(delay) })
  assert.equal(receipt.status, 'verified')
  assert.equal(receipt.same_bytes, true)
  assert.deepEqual(receipt.attempts.map(attempt => attempt.exit), [3, 0])
  assert.deepEqual(delays, [5000])
  assert.ok(receipt.attempts.every(attempt => Number.isFinite(Date.parse(attempt.started_at))))
  assert.deepEqual(fixture.calls.filter(args => args.includes('--check-notarization')), Array(2).fill(['--verify', '--strict', '-R=notarized', '--check-notarization', fixture.executable]))
})

test('persistent real fixture requirement failures retain all three results and fail closed', async t => {
  const fixture = assessmentFixture(t, [requirementFailure])
  const delays = []
  let receipt
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, {
    execute: fixture.execute, wait: async delay => delays.push(delay), onDiagnostic: value => { receipt = value }
  }), /failed after 3 assessments/)
  assert.equal(receipt.status, 'failed')
  assert.deepEqual(receipt.attempts.map(attempt => attempt.exit), [3, 3, 3])
  assert.deepEqual(delays, [5000, 15000])
})

test('invalid strict signatures cannot invoke the notarization verifier', async t => {
  const fixture = assessmentFixture(t, [{ status: 0 }])
  const calls = []
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, { execute: (command, args, options) => {
    calls.push(args)
    return args.includes('--strict') && !args.includes('--check-notarization')
      ? { status: 1, stderr: 'invalid signature' }
      : fixture.execute(command, args, options)
  } }), /strict signature verification failed/)
  assert.deepEqual(calls, [['--verify', '--strict', fixture.executable]])
})

test('verifier timeout is recorded once and cannot retry', async t => {
  const fixture = assessmentFixture(t, [{ status: 0 }])
  let receipt
  let delays = 0
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, {
    execute: (command, args, options) => args.includes('--check-notarization')
      ? { status: null, signal: 'SIGKILL', error: Object.assign(new Error('owned timeout'), { code: 'ETIMEDOUT' }) }
      : fixture.execute(command, args, options),
    wait: async () => { delays++ }, onDiagnostic: value => { receipt = value }
  }), /ETIMEDOUT/)
  assert.equal(receipt.attempts.length, 1)
  assert.equal(receipt.attempts[0].error_code, 'ETIMEDOUT')
  assert.equal(delays, 0)
})

test('changed bytes after a failed assessment cannot be retried or accepted', async t => {
  const fixture = assessmentFixture(t, [requirementFailure, { status: 0 }])
  let receipt
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, {
    execute: (command, args, options) => {
      const result = fixture.execute(command, args, options)
      if (args.includes('--check-notarization')) fs.appendFileSync(fixture.executable, ' changed')
      return result
    }, wait: async () => {}, onDiagnostic: value => { receipt = value }
  }), /bytes or signature changed/)
  assert.equal(receipt.same_bytes, false)
  assert.equal(receipt.attempts.length, 1)
})

test('changed CDHash cannot accept an otherwise successful assessment', async t => {
  const fixture = assessmentFixture(t, [{ status: 0 }])
  let assessed = false
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, {
    execute: (command, args, options) => {
      const result = fixture.execute(command, args, options)
      if (args.includes('--check-notarization')) assessed = true
      if (assessed && args.includes('--display')) result.stderr = `CDHash=${'b'.repeat(40)}\n`
      return result
    }, wait: async () => {}
  }), /bytes or signature changed/)
})

test('retargeted executable paths cannot retry even when the replacement bytes match', {
  skip: process.platform === 'win32'
}, async t => {
  const fixture = assessmentFixture(t, [requirementFailure, { status: 0 }])
  const first = `${fixture.executable}-first`
  const second = `${fixture.executable}-second`
  fs.renameSync(fixture.executable, first)
  fs.copyFileSync(first, second)
  fs.symlinkSync(first, fixture.executable)
  let receipt
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, {
    execute: (command, args, options) => {
      const result = fixture.execute(command, args, options)
      if (args.includes('--check-notarization')) {
        fs.unlinkSync(fixture.executable)
        fs.symlinkSync(second, fixture.executable)
      }
      return result
    }, wait: async () => {}, onDiagnostic: value => { receipt = value }
  }), /bytes or signature changed/)
  assert.equal(receipt.same_bytes, false)
  assert.equal(receipt.attempts.length, 1)
  assert.equal(receipt.sha256, receipt.observed_identity.sha256)
  assert.notEqual(receipt.realpath, receipt.observed_identity.realpath)
})

test('non-requirement verifier errors cannot retry', async t => {
  const fixture = assessmentFixture(t, [{ status: 1, stderr: 'unrelated verifier error' }, { status: 0 }])
  let delays = 0
  await assert.rejects(verifyNotarizedMacExecutable(fixture.executable, accepted, {
    execute: fixture.execute, wait: async () => { delays++ }
  }), /without a retryable requirement result/)
  assert.equal(fixture.calls.filter(args => args.includes('--check-notarization')).length, 1)
  assert.equal(delays, 0)
})

test('missing or rejected notarization receipts cannot launch any verifier', async () => {
  for (const notarization of [null, { ...accepted, status: 'Invalid' }, { ...accepted, issues: ['rejected item'] }, { status: 'Accepted' }]) {
    let calls = 0
    await assert.rejects(verifyNotarizedMacExecutable('unused fixture', notarization, { execute: () => { calls++ } }), /Accepted submission with no issues/)
    assert.equal(calls, 0)
  }
})
