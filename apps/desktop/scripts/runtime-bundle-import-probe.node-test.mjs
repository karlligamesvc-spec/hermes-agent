import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { probeRuntimeImports } from '../../../scripts/build-runtime-bundle.mjs'

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
