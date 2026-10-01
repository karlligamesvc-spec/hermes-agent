import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { probeBundledBackend, removeOwnedRuntimeTree, runtimeSmokeEnvironment, terminateOwnedSmokeProcess } from '../../../scripts/runtime-bundle-offline-smoke.mjs'

function ownedFixture(executable, code, codeFlag = '-e') {
  const child = spawn(executable, [codeFlag, code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const closed = new Promise(resolve => child.once('close', resolve))
  const ready = new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('owned fixture did not become ready')), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`owned fixture exited early: ${code}`)) })
    child.stdout.on('data', bytes => {
      output += bytes
      if (output.includes('\n')) {
        clearTimeout(timer)
        try { resolve(JSON.parse(output.split('\n')[0])) } catch (error) { reject(error) }
      }
    })
  })
  return { child, closed, ready }
}

async function assertFixtureRetired(pid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`controlled fixture PID ${pid} did not retire within 5 seconds`)
}

test('backend smoke rejects failed spawn and early executable exit without hanging cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-spawn-'))
  const manifest = { os: process.platform === 'win32' ? 'win' : 'mac' }
  const python = path.join(root, 'venv', manifest.os === 'win' ? 'Scripts/python.exe' : 'bin/python')
  async function rejectsPromptly(expected) {
    let timer
    try {
      await assert.rejects(Promise.race([
        probeBundledBackend(root, manifest, runtimeSmokeEnvironment(root, path.join(root, 'home'), manifest)),
        // Native executable verification/startup may exceed two seconds. The
        // error predicate still rejects a cleanup timeout or a late-close hang.
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned child cleanup hung')), 6000) })
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
  } finally { removeOwnedRuntimeTree(root) }
})

test('owned shutdown closes a real child without terminating an independent child', async () => {
  const code = 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)'
  const owned = ownedFixture(process.execPath, code)
  const bystander = ownedFixture(process.execPath, code)
  try {
    assert.equal((await owned.ready).pid, owned.child.pid)
    assert.equal((await bystander.ready).pid, bystander.child.pid)
    await terminateOwnedSmokeProcess(owned.child, owned.closed)
    assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null)
    assert.equal(bystander.child.exitCode, null)
    assert.equal(bystander.child.signalCode, null)
    assert.doesNotThrow(() => process.kill(bystander.child.pid, 0))
  } finally {
    try { await terminateOwnedSmokeProcess(owned.child, owned.closed) }
    finally { await terminateOwnedSmokeProcess(bystander.child, bystander.closed) }
  }
})

test('native Windows tree shutdown releases an actual locked uv.exe and cleanup fails closed while locked', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const resolved = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(resolved.status, 0, resolved.stderr)
  const parentPython = resolved.stdout.trim()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-win-lock-'))
  const locked = path.join(root, 'locked')
  const executable = path.join(locked, 'uv.exe')
  fs.mkdirSync(locked)
  fs.copyFileSync(process.execPath, executable)
  const fixtureToken = randomUUID()
  const grandchildCode = `console.log(JSON.stringify({pid:process.pid,fixtureToken:${JSON.stringify(fixtureToken)}})); setInterval(()=>{},1000)`
  // Python matches the backend's subprocess lineage. A Node parent would put
  // its child in a libuv kill-on-parent-close job, masking a missing /T.
  const code = `import subprocess,sys,threading; subprocess.Popen([${JSON.stringify(executable)},'-e',${JSON.stringify(grandchildCode)}],stdout=sys.stdout,stderr=sys.stderr); threading.Event().wait()`
  const owned = ownedFixture(parentPython, code, '-c')
  const bystander = ownedFixture(process.execPath, grandchildCode)
  let descendantPid
  try {
    const ready = await owned.ready
    assert.equal(ready.fixtureToken, fixtureToken)
    descendantPid = ready.pid
    assert.notEqual(descendantPid, owned.child.pid)
    assert.equal((await bystander.ready).pid, bystander.child.pid)
    assert.doesNotThrow(() => process.kill(descendantPid, 0))
    // Native executable locking, not a mocked fs error. Bounded retries must
    // still reject a process that has not been shut down.
    assert.throws(() => removeOwnedRuntimeTree(locked), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code))
    assert.ok(fs.existsSync(executable), 'failed cleanup must retain the actual locked executable')
    await terminateOwnedSmokeProcess(owned.child, owned.closed)
    // taskkill/stdio close can precede final kernel process retirement.
    await assertFixtureRetired(descendantPid)
    assert.doesNotThrow(() => process.kill(bystander.child.pid, 0))
    assert.equal(bystander.child.exitCode, null)
    removeOwnedRuntimeTree(locked)
    assert.equal(fs.existsSync(locked), false, 'all executable locks must be released before cleanup succeeds')
    console.log(JSON.stringify({ nativeWindowsOwnedTree: true, parentInterpreter: parentPython, ownedPid: owned.child.pid, descendantPid, bystanderPid: bystander.child.pid, lockedCleanupRejected: true, removedAfterTreeShutdown: true }))
  } finally {
    // Teardown is independent of the implementation under reversal. Each PID
    // comes from this fixture's live ChildProcess or token-bearing readiness.
    // Never scan, target images, or abandon bystander cleanup after an error.
    const cleanupErrors = []
    function killFixture(pid) {
      if (!pid) return
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe', timeout: 10_000 })
    }
    try { killFixture(descendantPid) } catch (error) { cleanupErrors.push(error) }
    for (const fixture of [owned, bystander]) {
      try {
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) killFixture(fixture.child.pid)
        let timer
        try {
          await Promise.race([fixture.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controlled fixture close timed out')), 5000) })])
        } finally { clearTimeout(timer) }
        assert.ok(fixture.child.exitCode !== null || fixture.child.signalCode !== null)
      } catch (error) { cleanupErrors.push(error) }
    }
    try {
      if (descendantPid) await assertFixtureRetired(descendantPid)
      removeOwnedRuntimeTree(root)
      assert.equal(fs.existsSync(root), false)
    } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'controlled Windows fixture cleanup failed')
    console.log(JSON.stringify({ recordedFixturesRetired: true, ownedPid: owned.child.pid, descendantPid, bystanderPid: bystander.child.pid, privateFixtureRemoved: true }))
  }
})

test('the isolated smoke rejects real external socket attempts while allowing a local API socket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-offline-'))
  const server = net.createServer(socket => socket.destroy())
  const inheritedControls = { UV_OFFLINE: process.env.UV_OFFLINE, PIP_NO_INDEX: process.env.PIP_NO_INDEX, HERMES_DISABLE_LAZY_INSTALLS: process.env.HERMES_DISABLE_LAZY_INSTALLS }
  process.env.UV_OFFLINE = '0'
  process.env.PIP_NO_INDEX = '0'
  process.env.HERMES_DISABLE_LAZY_INSTALLS = '0'
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
    assert.equal(env.HERMES_DISABLE_LAZY_INSTALLS, '1')
    let python = '/usr/bin/python3'
    if (process.platform === 'win32') {
      const resolved = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
      assert.equal(resolved.status, 0, resolved.stderr)
      python = resolved.stdout.trim()
    }
    const code = `import errno, os, socket
assert os.environ['UV_OFFLINE'] == '1'
assert os.environ['PIP_NO_INDEX'] == '1'
assert os.environ['HERMES_DISABLE_LAZY_INSTALLS'] == '1'
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
    removeOwnedRuntimeTree(root)
  }
})
