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
  fs.writeFileSync(script, `import signal,time\nfrom gateway.status import acquire_gateway_runtime_lock,write_pid_file\nassert acquire_gateway_runtime_lock()\nwrite_pid_file()\n${wedged ? 'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n' : ''}print('ready',flush=True)\nwhile True: time.sleep(1)\n`)
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
    assert.equal(record.pid, child.pid)

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
    assert.deepEqual(await retire(process.pid), [child.pid])
    await closed
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.deepEqual(await retire(process.pid), [], 'a second update is idempotent')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL')}
    await closed
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 35_000)
