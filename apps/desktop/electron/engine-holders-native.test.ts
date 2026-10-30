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
const macTest = process.platform === 'darwin' ? test : test.skip
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

// hc-1117: a process that outlived what started it. `script` runs with the engine's interpreter
// path as argv[0] and a working directory outside the engine, so only that argv[0] ties it to the engine.
const SLEEP = "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('up'); time.sleep(120)"

interface LostFixture {
  home: string
  root: string
  python: string
  enginePython: string
  env: NodeJS.ProcessEnv
  pids: number[]
}

function lostFixture(): LostFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-holder-lost-'))
  const root = path.join(home, 'hermes-agent')
  const python = fixturePython()

  fs.mkdirSync(path.join(root, '.runtime', 'bin'), { recursive: true })
  fs.symlinkSync(path.dirname(path.dirname(python)), path.join(root, 'venv'), process.platform === 'win32' ? 'junction' : 'dir')
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONPATH

  return { home, root, python, enginePython: path.join(root, 'venv', bin), env, pids: [] }
}

function endLost(fixture: LostFixture) {
  for (const pid of fixture.pids) {
    // The launcher started each in its own session, so the group takes a shell's children with it.
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL') } catch { /* already ended */ }
  }

  fs.rmSync(fixture.home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
}

/** Starts `argv` from a launcher that exits at once, so it outlives its parent. Returns its PID. */
async function launchLost(fixture: LostFixture, argv: string[], cwd = fixture.home): Promise<number> {
  const { stdout } = await exec(fixture.python, ['-c', LAUNCH, cwd, ...argv], { env: fixture.env, timeout: 10_000 })
  const pid = Number(stdout.trim())

  fixture.pids.push(pid)

  return pid
}

const fileShows = (file: string) => () => (fs.existsSync(file) && fs.readFileSync(file, 'utf8') ? true : undefined)

nativeTest('hc-1117: a real orphaned command on the engine interpreter is a leftover APEX ends after confirmation', async () => {
  const fixture = lostFixture()
  const up = path.join(fixture.home, 'up')

  try {
    const pid = await launchLost(fixture, [fixture.enginePython, '-c', SLEEP, up])

    await waitFor(fileShows(up), 'the command to start')

    const holders = await waitFor(async () => {
      const found = await holdersOf(fixture.root)

      return found[pid]?.kind === 'leftover_child' ? found : undefined
    }, 'the command to be orphaned')

    assert.deepEqual([holders[pid]?.kind, holders[pid]?.endable, holders[pid]?.engineRuntime], ['leftover_child', true, true])

    const logs: string[] = []
    const gate = createRuntimeSwitchGate({ activeRoot: fixture.root, hermesHome: fixture.home, log: message => void logs.push(message) } as never)

    assert.deepEqual(await gate.endLeftovers([{ pid, created: holders[pid]!.created! + 1 }]), {}, 'another start time is another process')
    assert.equal((await holdersOf(fixture.root))[pid]?.kind, 'leftover_child')
    assert.deepEqual(await gate.endLeftovers([{ pid, created: holders[pid]!.created! }]), { [pid]: 'terminated' })
    assert.deepEqual(Object.keys(await holdersOf(fixture.root)), [])
  } finally {
    endLost(fixture)
  }
}, 60_000)

nativeTest('hc-1117: the same orphan on another interpreter is only named, even with its working directory in the engine', async () => {
  const fixture = lostFixture()
  const up = path.join(fixture.home, 'up')

  try {
    const pid = await launchLost(fixture, [fixture.python, '-c', SLEEP, up], fixture.root)

    await waitFor(fileShows(up), 'the command to start')

    const holders = await waitFor(async () => {
      const found = await holdersOf(fixture.root)

      return found[pid]?.parent === 1 || found[pid]?.parent === null ? found : undefined
    }, 'the command to be orphaned')

    assert.deepEqual([holders[pid]?.kind, holders[pid]?.endable, holders[pid]?.engineRuntime], ['other', false, false])
  } finally {
    endLost(fixture)
  }
}, 60_000)

macTest('hc-1117: under the shell the engine runs it in, the command is a leftover while that shell lives', async () => {
  const fixture = lostFixture()
  const up = path.join(fixture.home, 'up')

  try {
    const line = `set +m; ${fixture.enginePython} -c "${SLEEP}" ${up} | cat`
    const shellPid = await launchLost(fixture, ['/bin/bash', '-lic', line])

    await waitFor(fileShows(up), 'the command to start')

    const holders = await waitFor(async () => {
      const found = await holdersOf(fixture.root)
      const entries = Object.values(found)

      return entries.length && entries.every(holder => holder?.ancestors?.some(ancestor => ancestor.pid === shellPid)) ? found : undefined
    }, 'the command to run under its shell')

    const [commandPid] = Object.keys(holders).map(Number)

    assert.equal(holders[commandPid]?.parent, shellPid, 'the shell stays alive in between')
    assert.deepEqual(holders[commandPid]?.ancestors?.map(ancestor => ancestor.pid).filter(pid => pid !== 0), [shellPid, 1])
    assert.deepEqual([holders[commandPid]?.kind, holders[commandPid]?.endable], ['leftover_child', true])
  } finally {
    endLost(fixture)
  }
}, 60_000)

macTest('hc-1117: the lost shell and its pipeline neighbour, inside the engine by working directory, end with the command', async () => {
  const fixture = lostFixture()
  const up = path.join(fixture.home, 'up')

  try {
    const line = `set +m; ${fixture.enginePython} -c "${SLEEP}" ${up} | cat`
    const shellPid = await launchLost(fixture, ['/bin/bash', '-lic', line], fixture.root)

    await waitFor(fileShows(up), 'the command to start')

    const holders = await waitFor(async () => {
      const found = await holdersOf(fixture.root)

      return Object.keys(found).length >= 3 ? found : undefined
    }, 'all three to hold the engine')

    assert.deepEqual(Object.values(holders).map(holder => holder?.kind), ['leftover_child', 'leftover_child', 'leftover_child'])
    assert.equal(holders[shellPid]?.endable, true)

    const gate = createRuntimeSwitchGate({ activeRoot: fixture.root, hermesHome: fixture.home, log: () => {} } as never)
    const confirmed = Object.entries(holders).map(([pid, holder]) => ({ pid: Number(pid), created: holder!.created! }))
    const ended = await gate.endLeftovers(confirmed)

    assert.deepEqual(Object.keys(ended).sort(), Object.keys(holders).sort())
    assert.deepEqual(await waitFor(async () => {
      const left = await holdersOf(fixture.root)

      return Object.keys(left).length ? undefined : left
    }, 'nothing to hold the engine any more'), {})
  } finally {
    endLost(fixture)
  }
}, 60_000)

// The layout of a packaged install: `hermes-agent` links to `versions/<key>`, whose `venv/bin/python`
// links to `.runtime/py/.../python3.14`, and the versions it replaced may still sit beside it.
function versionedFixture(fixture: LostFixture, key: string) {
  const version = path.join(fixture.home, 'versions', key)
  const real = fs.realpathSync(fixture.python)
  const prefix = path.dirname(path.dirname(real))
  const tool = path.join(version, '.runtime', 'bin', 'python3.14')

  const fixtureLib = path.join(path.dirname(path.dirname(fixture.python)), 'lib')
  const [pythonLib] = fs.readdirSync(fixtureLib).filter(name => name.startsWith('python'))
  const packages = path.join(version, 'venv', 'lib', pythonLib!)

  fs.mkdirSync(path.dirname(tool), { recursive: true })
  fs.copyFileSync(real, tool)
  fs.symlinkSync(path.join(prefix, 'lib'), path.join(version, '.runtime', 'lib'))
  fs.mkdirSync(path.join(version, 'venv', 'bin'), { recursive: true })
  fs.symlinkSync('../../.runtime/bin/python3.14', path.join(version, 'venv', 'bin', 'python'))
  fs.writeFileSync(path.join(version, 'venv', 'pyvenv.cfg'), `home = ${path.dirname(tool)}
`)
  fs.mkdirSync(packages, { recursive: true })
  fs.symlinkSync(path.join(fixtureLib, pythonLib!, 'site-packages'), path.join(packages, 'site-packages'))

  return { prefix, tool }
}

function versionedRoot(fixture: LostFixture, key: string): string {
  const root = path.join(fixture.home, 'versioned-home', 'hermes-agent')

  fs.mkdirSync(path.dirname(root), { recursive: true })
  fs.symlinkSync(path.join(fixture.home, 'versions'), path.join(path.dirname(root), 'versions'))
  fs.symlinkSync(path.join('versions', key), root)

  return root
}

async function launchWithArgv0(fixture: LostFixture, executable: string, argv: string[], prefix: string): Promise<number> {
  const launch = 'import json,subprocess,sys; p=subprocess.Popen(json.loads(sys.argv[2]),executable=sys.argv[1],start_new_session=True,cwd=sys.argv[3],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)'
  const { stdout } = await exec(fixture.python, ['-c', launch, executable, JSON.stringify(argv), fixture.home], { env: { ...fixture.env, PYTHONHOME: prefix }, timeout: 10_000 })
  const pid = Number(stdout.trim())

  fixture.pids.push(pid)

  return pid
}

// The holder a stuck Mac logged on 10-30: PPID 1, exe in `versions/<key>/.runtime`, argv[0] through
// the `hermes-agent` link. It is ended by the same exe the scan reported.
macTest('hc-1117: the shape from the field, exe in versions/<key>/.runtime and argv[0] through the link, is a leftover', async () => {
  const fixture = lostFixture()

  try {
    versionedFixture(fixture, 'd6af670cd6a9')
    const root = versionedRoot(fixture, 'd6af670cd6a9')
    const pid = await launchLost(fixture, [path.join(root, 'venv', 'bin', 'python'), '-c', 'import time; time.sleep(120)'])

    const holders = await waitFor(async () => {
      const found = await holdersOf(root)

      return found[pid]?.parent === 1 ? found : undefined
    }, 'the process to be orphaned')

    assert.ok(holders[pid]?.exe.endsWith(path.join('versions', 'd6af670cd6a9', '.runtime', 'bin', 'python3.14')), holders[pid]?.exe)
    assert.deepEqual([holders[pid]?.kind, holders[pid]?.endable, holders[pid]?.engineRuntime], ['leftover_child', true, true])

    const gate = createRuntimeSwitchGate({ activeRoot: root, hermesHome: fixture.home, log: () => {} } as never)

    assert.deepEqual(await gate.endLeftovers([{ pid, created: holders[pid]!.created! }]), { [pid]: 'terminated' })
  } finally {
    endLost(fixture)
  }
}, 60_000)

macTest.each([
  ['through the link in argv[0]', (root: string) => [path.join(root, 'venv', 'bin', 'python'), '-c', 'import time; time.sleep(120)']],
  ['with a bare argv[0] and a script path under the link', (root: string) => ['python3', '-c', 'import time; time.sleep(120)', path.join(root, 'tools', 'render.py')]]
])('hc-1117: a process left on the version this one replaced is a leftover, %s', async (_label, argv) => {
  const fixture = lostFixture()

  try {
    const { prefix, tool } = versionedFixture(fixture, 'old000000000')

    versionedFixture(fixture, 'new000000000')
    const root = versionedRoot(fixture, 'new000000000')
    const pid = await launchWithArgv0(fixture, tool, argv(root), prefix)

    const holders = await waitFor(async () => {
      const found = await holdersOf(root)

      return found[pid]?.parent === 1 ? found : undefined
    }, 'the process to be orphaned')

    assert.ok(holders[pid]?.exe.includes(path.join('versions', 'old000000000', '.runtime')), holders[pid]?.exe)
    assert.deepEqual([holders[pid]?.kind, holders[pid]?.endable, holders[pid]?.engineRuntime], ['leftover_child', true, true])
  } finally {
    endLost(fixture)
  }
}, 60_000)

macTest('hc-1117: a process elsewhere in another installed version is only named', async () => {
  const fixture = lostFixture()

  try {
    const { prefix, tool } = versionedFixture(fixture, 'new000000000')
    const stray = path.join(fixture.home, 'versions', 'old000000000', 'node_modules', 'bin', 'python3.14')

    fs.mkdirSync(path.dirname(stray), { recursive: true })
    fs.copyFileSync(tool, stray)
    fs.symlinkSync(path.join(prefix, 'lib'), path.join(path.dirname(path.dirname(stray)), 'lib'))
    const root = versionedRoot(fixture, 'new000000000')
    const pid = await launchWithArgv0(fixture, stray, ['python3', '-c', 'import time; time.sleep(120)', path.join(root, 'tools', 'render.py')], prefix)

    const holders = await waitFor(async () => {
      const found = await holdersOf(root)

      return found[pid]?.parent === 1 ? found : undefined
    }, 'the process to be orphaned')

    assert.deepEqual([holders[pid]?.kind, holders[pid]?.endable, holders[pid]?.engineRuntime], ['other', false, false])
  } finally {
    endLost(fixture)
  }
}, 60_000)

// A packaged engine's `venv/bin/python` resolves to `.runtime/py/.../python3.14` inside the engine,
// and a command the shell finds on PATH has a bare argv[0], so only the executable says what it is.
macTest.each([
  ['.runtime', 'leftover_child', true],
  ['node_modules', 'other', false]
])('hc-1117: by its executable alone, with a bare argv[0], a process in %s is %s', async (top, kind, endable) => {
  const fixture = lostFixture()
  const tool = path.join(fixture.root, top, 'bin', 'python3.14')
  const real = fs.realpathSync(fixture.python)
  const prefix = path.dirname(path.dirname(real))

  fs.mkdirSync(path.dirname(tool), { recursive: true })
  fs.copyFileSync(real, tool)
  fs.symlinkSync(path.join(prefix, 'lib'), path.join(fixture.root, top, 'lib'))

  try {
    const launch = 'import subprocess,sys; p=subprocess.Popen(["python3","-c","import time; time.sleep(120)"],executable=sys.argv[1],start_new_session=True,cwd=sys.argv[2],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)'
    const { stdout } = await exec(fixture.python, ['-c', launch, tool, fixture.home], { env: { ...fixture.env, PYTHONHOME: prefix }, timeout: 10_000 })
    const pid = Number(stdout.trim())

    fixture.pids.push(pid)

    const holders = await waitFor(async () => {
      const found = await holdersOf(fixture.root)

      return found[pid]?.parent === 1 ? found : undefined
    }, 'the process to be orphaned')

    assert.equal(holders[pid]?.argv[0], 'python3')
    assert.equal(holders[pid]?.engineExe, true)
    assert.deepEqual([holders[pid]?.kind, holders[pid]?.endable, holders[pid]?.engineRuntime], [kind, endable, endable])
  } finally {
    endLost(fixture)
  }
}, 60_000)

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
