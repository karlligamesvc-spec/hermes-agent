import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { test } from 'vitest'

import { gatewayFixtureScript, gatewayRuntimeState } from './fixtures/runtime-smoke'
import { assertPackagedRuntimeIdle } from './packaged-runtime'
import { RETIRE_GATEWAYS } from './runtime-gateway-retirement'
import { isRuntimeUpdateBusy } from './runtime-update-busy'

const exec = promisify(execFile)

const nativeTest = ['darwin', 'win32'].includes(process.platform) ? test : test.skip

nativeTest.each([false, true])('real gateway shutdown preserves foreign identities and retires owned workers (wedged=%s)', async wedged => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-gateway-retire-'))
  const root = path.join(home, 'engine')
  const source = path.resolve('../..')
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const python = process.env.HERMES_PYTHON || path.join(path.dirname(commonGit), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const env = { ...process.env, HERMES_HOME: home, PYTHONPATH: source, PYTHONDONTWRITEBYTECODE: '1' }
  fs.mkdirSync(path.join(root, 'gateway'), { recursive: true })
  const script = path.join(root, 'gateway', 'run.py')
  fs.writeFileSync(script, gatewayFixtureScript({ wedged }))
  const child = spawn(python, [script], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let stderr = ''
  child.stderr!.on('data', data => { stderr += data })

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Gateway did not start: ${stderr}`)), 10_000)
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Gateway exited: ${stderr}`)) })
      child.stdout!.once('data', () => { clearTimeout(timeout); resolve() })
    })
    const pidFile = path.join(home, 'gateway.pid')
    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    const owner = JSON.parse(fs.readFileSync(path.join(home, 'owner.pid'), 'utf8'))
    assert.equal(record.pid, owner.pid)
    if (process.platform !== 'win32') {assert.equal(record.pid, child.pid)}

    const retire = async (parent: number) => {
      const { stdout } = await exec(python, ['-c', RETIRE_GATEWAYS, root, home, String(parent)], { env, cwd: home, timeout: 20_000 })

      return JSON.parse(stdout.trim())
    }

    // Another live owner, a forged home, and a recycled PID must each survive.
    assert.deepEqual(await retire(-1), [])

    for (const invalid of [{ ...record, hermes_home: path.join(home, 'other') }, { ...record, start_time: record.start_time + 100 }]) {
      fs.writeFileSync(pidFile, JSON.stringify(invalid))
      assert.deepEqual(await retire(process.pid), [])
      assert.equal(child.exitCode, null)
    }

    fs.writeFileSync(pidFile, JSON.stringify(record))
    // A live IM turn and missing activity evidence must survive the update.
    await assert.rejects(retire(process.pid), /APEX_RUNTIME_UPDATE_BUSY/)
    const statusFile = path.join(home, 'gateway_state.json')
    fs.writeFileSync(statusFile, JSON.stringify(gatewayRuntimeState(record, 1)))
    await assert.rejects(retire(process.pid), /APEX_RUNTIME_UPDATE_BUSY/)
    assert.equal(child.exitCode, null)
    fs.writeFileSync(statusFile, JSON.stringify(gatewayRuntimeState(record, 0)))
    const inspected = JSON.parse((await exec(python, ['-c', RETIRE_GATEWAYS, root, home, String(process.pid), 'inspect'], { env, cwd: home, timeout: 20_000 })).stdout.trim())
    // On Windows child.pid is the venv launcher in front of the worker; it retires with it.
    const redirectors = record.pid === child.pid ? [] : [child.pid]
    assert.ok([record.pid, ...redirectors].every(pid => inspected.includes(pid)))
    assert.equal(child.exitCode, null, 'preflight cannot disconnect an idle gateway')
    assert.deepEqual(await retire(process.pid), [record.pid, ...redirectors])
    await closed
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    const descendant = JSON.parse(fs.readFileSync(path.join(home, 'descendant.pid'), 'utf8')).pid
    await exec(python, ['-c', 'import psutil,sys; p=int(sys.argv[1]); assert not psutil.pid_exists(p) or psutil.Process(p).status()==psutil.STATUS_ZOMBIE', String(descendant)], { env, cwd: home, timeout: 5000 })
    assert.deepEqual(await retire(process.pid), [], 'a second update is idempotent')
  } finally {
    // A Windows venv launcher is a redirector. Killing only child.pid leaks
    // its Python worker and inherited pipes, masking the original assertion.
    const ownerFile = path.join(home, 'owner.pid')
    if (fs.existsSync(ownerFile)) {
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      await exec(python, ['-c', 'import psutil,sys; p=int(sys.argv[1]); c=float(sys.argv[2]); owner=psutil.Process(p) if psutil.pid_exists(p) else None; children=owner.children(recursive=True) if owner and owner.create_time()==c else []; [child.kill() for child in children if child.is_running()]; (owner.kill() if owner and owner.create_time()==c else None)', String(owner.pid), String(owner.created)], { env, cwd: home, timeout: 5000 }).catch(() => {})
    }
    if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL')}
    const descendantFile = path.join(home, 'descendant.pid')

    if (fs.existsSync(descendantFile)) {
      const record = JSON.parse(fs.readFileSync(descendantFile, 'utf8'))
      await exec(python, ['-c', 'import psutil,sys; p=int(sys.argv[1]); c=float(sys.argv[2]); (psutil.Process(p).kill() if psutil.pid_exists(p) and psutil.Process(p).create_time()==c else None)', String(record.pid), String(record.created)], { env, cwd: home, timeout: 5000 }).catch(() => {})
    }

    await closed
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 35_000)

// macOS has no venv launcher, so the fixture plays the Windows one: the same command line re-run
// as a child it waits on. The switch must exempt that redirector while inspecting, wait it out
// (or end it) while retiring, and still keep a gateway whose chain ends at a foreign owner.
// Windows runs the real launcher in the test above.
const redirectorTest = process.platform === 'darwin' ? test : test.skip

async function launchRedirectedGateway({ lingerSeconds, foreignOwner }: { lingerSeconds: number; foreignOwner: boolean }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-gateway-redirector-'))
  const root = path.join(home, 'engine')
  const verifiedRoot = path.join(home, 'verified')
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const venv = path.join(path.dirname(commonGit), '.venv')
  const python = process.env.HERMES_PYTHON || path.join(venv, 'bin/python')
  const env = { ...process.env, HERMES_HOME: home, PYTHONPATH: path.resolve('../..'), PYTHONDONTWRITEBYTECODE: '1' }
  fs.mkdirSync(path.join(root, 'gateway'), { recursive: true })
  fs.mkdirSync(verifiedRoot)
  fs.symlinkSync(venv, path.join(verifiedRoot, 'venv'))
  const script = path.join(root, 'gateway', 'run.py')
  fs.writeFileSync(script, gatewayFixtureScript({ wedged: true }))
  // A foreign owner: another app's process outside the engine, whose own command line is not a
  // gateway's, that started the redirector.
  const owner = path.join(home, 'foreign_owner.py')
  fs.writeFileSync(owner, "import os,subprocess,sys\nsys.exit(subprocess.call([sys.executable, os.environ['APEX_FOREIGN_TARGET']]))\n")

  const child = spawn(python, foreignOwner ? [owner] : [script], {
    cwd: root, env: { ...env, APEX_FIXTURE_REDIRECTOR: String(lingerSeconds), APEX_FOREIGN_TARGET: script }, stdio: ['ignore', 'pipe', 'pipe']
  })

  const closed = once(child, 'close')
  let stderr = ''
  child.stderr!.on('data', data => { stderr += data })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Gateway did not start: ${stderr}`)), 10_000)
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Gateway exited: ${stderr}`)) })
    child.stdout!.once('data', () => { clearTimeout(timeout); resolve() })
  })
  const record = JSON.parse(fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8'))
  fs.writeFileSync(path.join(home, 'gateway_state.json'), JSON.stringify(gatewayRuntimeState(record, 0)))
  const { stdout: chain } = await exec(python, ['-c', 'import json,psutil,sys; p=psutil.Process(int(sys.argv[1])); print(json.dumps([a.pid for a in p.parents()]))', String(record.pid)], { env, timeout: 5000 })

  const retire = async (mode: 'inspect' | 'retire') =>
    JSON.parse((await exec(python, ['-c', RETIRE_GATEWAYS, root, home, String(process.pid), mode], { env, cwd: home, timeout: 30_000 })).stdout.trim()) as number[]

  const cleanup = async () => {
    // Every process this test started: the owner or redirector it spawned, and their descendants.
    await exec(python, ['-c', 'import psutil,sys; r=psutil.Process(int(sys.argv[1])); procs=[*r.children(recursive=True), r]; [p.kill() for p in procs if p.is_running()]', String(child.pid)], { env, timeout: 5000 }).catch(() => {})
    const descendantFile = path.join(home, 'descendant.pid')

    if (fs.existsSync(descendantFile)) {
      const descendant = JSON.parse(fs.readFileSync(descendantFile, 'utf8'))
      await exec(python, ['-c', 'import psutil,sys; p=int(sys.argv[1]); c=float(sys.argv[2]); (psutil.Process(p).kill() if psutil.pid_exists(p) and psutil.Process(p).create_time()==c else None)', String(descendant.pid), String(descendant.created)], { env, timeout: 5000 }).catch(() => {})
    }

    await closed
    fs.rmSync(home, { recursive: true, force: true })
  }

  return { root, verifiedRoot, child, record, ancestors: JSON.parse(chain) as number[], retire, cleanup }
}

redirectorTest.each([3, 120])('a launcher redirector is exempt while inspecting and gone before the switch (it lingers %ss after its worker)', async lingerSeconds => {
  const gateway = await launchRedirectedGateway({ lingerSeconds, foreignOwner: false })

  try {
    const redirector = gateway.child.pid!
    assert.equal(gateway.ancestors[0], redirector, 'the worker runs behind the redirector')
    const inspected = await gateway.retire('inspect')
    assert.ok(inspected.includes(gateway.record.pid) && inspected.includes(redirector), `inspect must list the redirector: ${inspected}`)
    // The switch gate's preflight exempts only what the switch will retire.
    assert.deepEqual((await assertPackagedRuntimeIdle(gateway.root, gateway.verifiedRoot, { retiringGatewayPids: inspected }))?.holderPids, [])
    assert.deepEqual(await gateway.retire('retire'), [gateway.record.pid, redirector])
    // The strict pre-switch scan has no exemptions: nothing of the gateway may remain.
    assert.deepEqual((await assertPackagedRuntimeIdle(gateway.root, gateway.verifiedRoot))?.holderPids, [])
  } finally {
    await gateway.cleanup()
  }
}, 60_000)

redirectorTest('a redirected gateway whose chain ends at a foreign owner is kept and defers the switch', async () => {
  const gateway = await launchRedirectedGateway({ lingerSeconds: 0, foreignOwner: true })

  try {
    assert.equal(gateway.ancestors[1], gateway.child.pid, 'the foreign owner started the redirector')
    assert.deepEqual(await gateway.retire('inspect'), [])
    await assert.rejects(assertPackagedRuntimeIdle(gateway.root, gateway.verifiedRoot, { retiringGatewayPids: [] }), isRuntimeUpdateBusy)
    assert.deepEqual(await gateway.retire('retire'), [])
    assert.doesNotThrow(() => process.kill(gateway.record.pid, 0), 'a foreign gateway keeps running')
  } finally {
    await gateway.cleanup()
  }
}, 60_000)
