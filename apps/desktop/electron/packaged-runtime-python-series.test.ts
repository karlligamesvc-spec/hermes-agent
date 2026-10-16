// hc-911: the packaged engine probe derives the expected Python series from the bundle itself.
// It hard-coded 3.11 and rejected every v0.22 bundle (CPython 3.14), which only a packaged
// APEX.app on a real machine exposed. Runs the probe's own lines on a real interpreter.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { PACKAGED_ENGINE_PYTHON_SERIES_PROBE } from './packaged-runtime'

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const series = spawnSync(PYTHON, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' })
const available = series.status === 0
const current = available ? series.stdout.trim() : ''

function probe(manifest: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-engine-series-'))

  try {
    if (manifest !== undefined) {fs.writeFileSync(path.join(root, '.bundle-manifest.json'), JSON.stringify(manifest))}
    const code = ['import json,pathlib,re,sys', 'root=pathlib.Path(sys.argv[1]).resolve()', ...PACKAGED_ENGINE_PYTHON_SERIES_PROBE].join('\n')

    return spawnSync(PYTHON, ['-c', code, root], { encoding: 'utf8' })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test.skipIf(!available)('the bundle manifest names the engine Python series', () => {
  assert.equal(probe({ components: { python: { version: `${current}.7` } } }).status, 0)
  const other = probe({ components: { python: { version: '2.7.18' } } })
  assert.notEqual(other.status, 0)
  assert.match(other.stderr, /engine Python version mismatch/)
})

test.skipIf(!available)('a manifest without a version falls back to the cpython-X.Y.Z directory', () => {
  assert.equal(probe({ components: { python: { path: `.runtime/py/cpython-${current}.4-macos-aarch64-none` } } }).status, 0)
  assert.match(probe({ components: { python: { path: '.runtime/py/cpython-2.7.18' } } }).stderr, /engine Python version mismatch/)
})

test.skipIf(!available)('a legacy tree with no manifest still expects 3.11', () => {
  const legacy = probe(undefined)
  assert.equal(legacy.status === 0, current === '3.11', legacy.stderr)
})
