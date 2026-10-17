import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { test } from 'vitest'

import { RETIRE_GATEWAYS } from './runtime-gateway-retirement'

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
  const descendantCode = "import json,os,pathlib,psutil,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(os.environ['HERMES_HOME'],'descendant.pid').write_text(json.dumps(dict(pid=os.getpid(),created=psutil.Process().create_time()))); time.sleep(120)"
  fs.writeFileSync(script, [
    'import json,os,pathlib,psutil,signal,subprocess,sys,time',
    'from gateway.status import acquire_gateway_runtime_lock,write_pid_file',
    'from utils import atomic_json_write',
    'assert acquire_gateway_runtime_lock()',
    'write_pid_file()',
    "pathlib.Path(os.environ['HERMES_HOME'],'owner.pid').write_text(json.dumps(dict(pid=os.getpid(),created=psutil.Process().create_time())))",
    `subprocess.Popen([sys.executable,'-c',${JSON.stringify(descendantCode)}])`,
    "while not pathlib.Path(os.environ['HERMES_HOME'],'descendant.pid').exists(): time.sleep(.01)",
    ...(wedged ? ['signal.signal(signal.SIGTERM,signal.SIG_IGN)'] : []),
    "print('ready',flush=True)",
    'while True:',
    "    if pathlib.Path(os.environ['HERMES_HOME'],'.drain_request.json').exists():",
    "        status=pathlib.Path(os.environ['HERMES_HOME'],'gateway_state.json'); state=json.loads(status.read_text()); state['gateway_state']='draining'; atomic_json_write(status,state)",
    '    time.sleep(.05)'
  ].join('\n'))
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
    fs.writeFileSync(statusFile, JSON.stringify({ ...record, gateway_state: 'running', active_agents: 1 }))
    await assert.rejects(retire(process.pid), /APEX_RUNTIME_UPDATE_BUSY/)
    assert.equal(child.exitCode, null)
    fs.writeFileSync(statusFile, JSON.stringify({ ...record, gateway_state: 'running', active_agents: 0 }))
    const inspected = await exec(python, ['-c', RETIRE_GATEWAYS, root, home, String(process.pid), 'inspect'], { env, cwd: home, timeout: 20_000 })
    assert.ok(JSON.parse(inspected.stdout.trim()).includes(record.pid))
    assert.equal(child.exitCode, null, 'preflight cannot disconnect an idle gateway')
    assert.deepEqual(await retire(process.pid), [record.pid])
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
