import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { probeBundledBackend, runtimeSmokeEnvironment } from '../../../scripts/runtime-bundle-offline-smoke.mjs'

test('backend smoke rejects failed spawn and early executable exit without hanging cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-spawn-'))
  const manifest = { os: process.platform === 'win32' ? 'win' : 'mac' }
  const python = path.join(root, 'venv', manifest.os === 'win' ? 'Scripts/python.exe' : 'bin/python')
  async function rejectsPromptly(expected) {
    let timer
    try {
      await assert.rejects(Promise.race([
        probeBundledBackend(root, manifest, runtimeSmokeEnvironment(root, path.join(root, 'home'), manifest)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned child cleanup hung')), 2000) })
      ]), expected)
    } finally { clearTimeout(timer) }
  }
  try {
    assert.equal(fs.existsSync(python), false)
    await rejectsPromptly(/Bundled backend exited before readiness:.*ENOENT/)
    // The real copied Node executable exits on Python's unsupported -m flag.
    // This exercises early close rather than another missing-file failure.
    fs.mkdirSync(path.dirname(python), { recursive: true })
    fs.copyFileSync(process.execPath, python)
    fs.chmodSync(python, 0o755)
    assert.ok(fs.statSync(python).size > 0)
    await rejectsPromptly(/Bundled backend exited before readiness: \d+/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the isolated smoke rejects real external socket attempts while allowing a local API socket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-offline-'))
  const server = net.createServer(socket => socket.destroy())
  const inheritedControls = { UV_OFFLINE: process.env.UV_OFFLINE, PIP_NO_INDEX: process.env.PIP_NO_INDEX }
  process.env.UV_OFFLINE = '0'
  process.env.PIP_NO_INDEX = '0'
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const home = path.join(root, 'home')
    const env = runtimeSmokeEnvironment(root, home, { os: process.platform === 'win32' ? 'win' : 'mac' })
    assert.equal(env.HOME, home)
    assert.ok(!Object.keys(env).some(name => name.toLowerCase() === 'path' && name !== 'PATH'))
    assert.equal(env.PYTHONHOME, undefined)
    assert.equal(env.VIRTUAL_ENV, undefined)
    assert.equal(env.UV_OFFLINE, '1')
    assert.equal(env.PIP_NO_INDEX, '1')
    let python = '/usr/bin/python3'
    if (process.platform === 'win32') {
      const resolved = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
      assert.equal(resolved.status, 0, resolved.stderr)
      python = resolved.stdout.trim()
    }
    const code = `import errno, os, socket
assert os.environ['UV_OFFLINE'] == '1'
assert os.environ['PIP_NO_INDEX'] == '1'
assert getattr(socket, '_hermes_offline_guard', False)
try: socket.create_connection(('203.0.113.1', 443), timeout=0.1)
except PermissionError as error: assert 'runtime smoke disallows external network' in str(error)
else: raise AssertionError('external network was not blocked')
assert socket.socket().connect_ex(('203.0.113.1', 443)) == errno.EACCES
sock = socket.create_connection(('127.0.0.1', ${server.address().port}), timeout=1)
sock.close()
print('guard-behavior-ok')
`
    const result = spawnSync(python, ['-c', code], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'guard-behavior-ok')
  } finally {
    for (const [key, value] of Object.entries(inheritedControls)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
