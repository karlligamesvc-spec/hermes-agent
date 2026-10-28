import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { test } from 'vitest'

import { type ClassifiedHolder, endableTargets } from './engine-holders'
import { assertPackagedRuntimeIdle, endEngineHolders } from './packaged-runtime'
import { createRuntimeSwitchGate } from './runtime-switch-gate'

// hc-1094 against real processes and real psutil: an orphaned copy of the exact Desktop gateway
// command is a leftover APEX may end, a live child of this process running the same command is
// not, and the end step signals only the confirmed process (PID + start time).
const exec = promisify(execFile)
const nativeTest = ['darwin', 'win32'].includes(process.platform) ? test : test.skip
const bin = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
const GATEWAY = ['-m', 'hermes_cli.main', 'gateway', 'run', '--replace']

// The fake engine module: report ready, optionally ignore SIGTERM, then idle.
const MAIN = [
  'import os,pathlib,signal,time',
  "if os.environ.get('FIXTURE_IGNORE_TERM'): signal.signal(signal.SIGTERM, signal.SIG_IGN)",
  "pathlib.Path(os.environ['FIXTURE_READY']).write_text(str(os.getpid()))",
  'time.sleep(120)'
].join('\n')

// Starts the command detached and exits at once, so the command outlives its parent.
const LAUNCH = [
  'import os,subprocess,sys',
  "kw=dict(creationflags=0x00000008|0x00000200) if os.name=='nt' else dict(start_new_session=True)",
  'p=subprocess.Popen(sys.argv[2:],cwd=sys.argv[1],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**kw)',
  'print(p.pid)'
].join('\n')

function fixturePython(): string {
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()

  return process.env.HERMES_PYTHON || path.join(path.dirname(commonGit), '.venv', bin)
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const value = await read()

    if (value !== undefined) {return value}

    if (Date.now() > deadline) {throw new Error(`timed out waiting for ${what}`)}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function holdersOf(root: string): Promise<Record<string, ClassifiedHolder | undefined>> {
  try {
    await assertPackagedRuntimeIdle(root, root)

    return {}
  } catch (error) {
    return (error as { idleProof: { holders: Record<string, ClassifiedHolder | undefined> } }).idleProof.holders
  }
}

nativeTest('a real orphaned Desktop gateway is ended after confirmation; a live child with the same command is left alone', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-holder-end-'))
  const root = path.join(home, 'hermes-agent')
  const python = fixturePython()
  const pids: number[] = []

  fs.mkdirSync(path.join(root, 'hermes_cli'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hermes_cli', '__init__.py'), '')
  fs.writeFileSync(path.join(root, 'hermes_cli', 'main.py'), MAIN)
  fs.symlinkSync(path.dirname(path.dirname(python)), path.join(root, 'venv'), process.platform === 'win32' ? 'junction' : 'dir')
  const enginePython = path.join(root, 'venv', bin)
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONPATH

  const ready = (name: string) => () => {
    const file = path.join(home, `${name}.pid`)

    return fs.existsSync(file) && fs.readFileSync(file, 'utf8') ? Number(fs.readFileSync(file, 'utf8')) : undefined
  }

  const orphan = async (name: string, extra: NodeJS.ProcessEnv = {}) => {
    await exec(python, ['-c', LAUNCH, root, enginePython, ...GATEWAY], { env: { ...env, ...extra, FIXTURE_READY: path.join(home, `${name}.pid`) }, timeout: 10_000 })
    const pid = await waitFor(ready(name), `${name} to start`)
    pids.push(pid)

    // The launcher has exited: the gateway's parent is gone (re-parented to pid 1 on macOS).
    return waitFor(async () => {
      const holders = await holdersOf(root)

      return holders[pid]?.kind === 'leftover_gateway' ? pid : undefined
    }, `${name} to be orphaned`)
  }

  const live = spawn(enginePython, GATEWAY, { cwd: root, env: { ...env, FIXTURE_READY: path.join(home, 'live.pid') }, stdio: 'ignore', windowsHide: true })
  const logs: string[] = []
  const gate = createRuntimeSwitchGate({ activeRoot: root, hermesHome: home, log: message => void logs.push(message) } as never)

  try {
    const livePid = await waitFor(ready('live'), 'the live child to start')
    const gentle = await orphan('gentle')
    const stubborn = await orphan('stubborn', { FIXTURE_IGNORE_TERM: '1' })
    const holders = await holdersOf(root)

    assert.deepEqual([holders[gentle]?.kind, holders[gentle]?.endable], ['leftover_gateway', true])
    assert.deepEqual([holders[stubborn]?.kind, holders[stubborn]?.endable], ['leftover_gateway', true])
    assert.deepEqual([holders[livePid]?.kind, holders[livePid]?.endable], ['apex_running', false], 'a live child is never a leftover')

    // A confirmation whose start time does not match is not the process the user saw.
    const stale = endableTargets(holders, [{ pid: gentle, created: holders[gentle]!.created! + 1 }])
    assert.deepEqual(stale, [])
    assert.deepEqual(await endEngineHolders(root, [{ pid: gentle, created: holders[gentle]!.created! + 1, exe: holders[gentle]!.exe }]), { [gentle]: 'changed' })
    assert.equal((await holdersOf(root))[gentle]?.kind, 'leftover_gateway', 'a mismatched identity is left running')

    // The user confirms everything shown, the live child included; only the leftovers end.
    const confirmed = Object.entries(holders).map(([pid, holder]) => ({ pid: Number(pid), created: holder!.created! }))
    const ended = await gate.endLeftovers(confirmed)

    assert.deepEqual(ended, { [gentle]: 'terminated', [stubborn]: 'killed' })
    assert.equal(live.exitCode, null, 'the live child keeps running')
    assert.deepEqual(Object.keys(await holdersOf(root)), [String(livePid)])
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, new RegExp(`^\\[engine-holders\\] end requested for .+: ${gentle} leftover_gateway terminated; ${stubborn} leftover_gateway killed; left alone: ${livePid} apex_running$`))
  } finally {
    live.kill('SIGKILL')

    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already ended */ }
    }

    fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}, 90_000)
