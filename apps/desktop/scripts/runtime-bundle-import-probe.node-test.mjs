import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { probeRuntimeImports } from '../../../scripts/build-runtime-bundle.mjs'
import { verifyNotarizedMacExecutable } from '../../../scripts/mac-runtime-payload.mjs'
import { runtimeSmokeEnvironment } from '../../../scripts/runtime-bundle-offline-smoke.mjs'

test('bundle smoke rejects a real runtime missing PyYAML', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-bundle-imports-'))
  const packageDir = path.join(root, 'hermes_cli')
  const wrapper = path.join(root, 'python-no-site')
  const env = { ...process.env, PYTHONPATH: root }

  fs.mkdirSync(packageDir)
  fs.writeFileSync(path.join(packageDir, '__init__.py'), '')
  fs.writeFileSync(path.join(packageDir, 'config.py'), '')
  fs.writeFileSync(path.join(root, 'dotenv.py'), '')
  fs.writeFileSync(path.join(root, 'run_agent.py'), '')
  fs.writeFileSync(path.join(root, 'toolsets.py'), '')
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/python3 -S "$@"\n')
  fs.chmodSync(wrapper, 0o755)

  try {
    assert.throws(() => probeRuntimeImports(wrapper, { env, cwd: root }), /runtime imports failed/)

    fs.writeFileSync(path.join(root, 'yaml.py'), '')
    assert.doesNotThrow(() => probeRuntimeImports(wrapper, { env, cwd: root }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Mac bundle rejects a signed but unnotarized executable with the sealed smoke PATH', {
  skip: process.platform !== 'darwin'
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-mac-gatekeeper-'))
  try {
    const env = runtimeSmokeEnvironment(root, path.join(root, 'home'), { os: 'mac' })
    assert.ok(!env.PATH.split(path.delimiter).includes('/usr/sbin'))
    const executable = path.join(root, 'unnotarized-tool')
    fs.copyFileSync('/usr/bin/true', executable)
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', executable], { env, encoding: 'utf8', shell: false })
    assert.equal(signed.error, undefined)
    assert.equal(signed.status, 0, signed.stderr)
    const signature = spawnSync('/usr/bin/codesign', ['--verify', '--strict', executable], { env, encoding: 'utf8', shell: false })
    assert.equal(signature.error, undefined)
    assert.equal(signature.status, 0, 'the control must have a valid signature before checking notarization')
    let receipt
    // Execute the production helper and real system verifier. A valid
    // signature alone must not satisfy its notarization requirement; release
    // jobs separately require all four real payloads to pass at both locations.
    await assert.rejects(verifyNotarizedMacExecutable(executable, { status: 'Accepted', submission_id: 'owned-negative-control', issues: [] }, {
      env, wait: async () => {}, onDiagnostic: value => { receipt = value }
    }), /notarization failed after 3 assessments/)
    assert.equal(receipt.status, 'failed')
    assert.equal(receipt.verifier, '/usr/bin/codesign')
    assert.deepEqual(receipt.requirement, ['--verify', '--strict', '-R=notarized', '--check-notarization'])
    assert.equal(receipt.attempts.length, 3, 'the actual notarization command must complete at every bounded assessment')
    for (const actual of receipt.attempts) {
      assert.equal(actual.error_code, null, 'the actual system notarization command must launch')
      assert.ok(Number.isInteger(actual.exit), 'the system verifier must complete with a real result')
      assert.notEqual(actual.exit, 0, 'a valid but unnotarized signature must be refused')
      assert.match(actual.stderr, /code failed to satisfy specified code requirement/)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
