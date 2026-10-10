import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterAll, beforeAll, test } from 'vitest'

import * as layout from './apex-bundle-layout'
import { checkForRuntimeUpdate } from './apex-runtime-latest'
import { buildDesktopBackendEnv, bundledRuntimePathEntries } from './backend-env'
import { createDeferredRuntimeUpdate } from './deferred-runtime-update'
import { buildTerminalScript, terminalScriptEnv } from './external-terminal'
import {
  armPackagedRuntimeUpdate,
  assertPackagedRuntimeIdle,
  createPackagedRuntimeGate,
  installPackagedRuntime,
  packagedRuntimeDecision,
  packagedRuntimeMatchesPin,
  type PackagedRuntimeOptions,
  type PackagedRuntimeRelease,
  readPackagedRuntime,
  shouldInstallPackagedRuntime
} from './packaged-runtime'
import { runPrimaryBackendStartup } from './primary-backend-startup'

const exec = promisify(execFile)
const commit = '36db3bdc67c03f6149b9ad7e503d953ed662d752'
const release: PackagedRuntimeRelease = { schemaVersion: 1, runtime_commit: commit, runtime_version: 'v2026.10.1-fork.36db3bdc', min_desktop_version: '0.17.31', uv_version: '0.11.28' }
const nativeOS = process.platform === 'win32' ? 'win' : 'mac'
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'System32', 'tar.exe') : '/usr/bin/tar'
const nativeTest = ['darwin', 'win32'].includes(process.platform) ? test : test.skip
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
let fixture: string
let resources: string
let manifest: Record<string, any>

// Real native tar, file paths, a real Node executable and an independent fixture verifier.
// The tiny payload substitutes for the multi-gigabyte engine; packaging separately probes the full engine.
beforeAll(() => {
  if (!['darwin', 'win32'].includes(process.platform)) {return}
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bundled-fixture-'))
  resources = path.join(fixture, 'Resources')
  const directory = path.join(resources, 'bundled-runtime')
  const tree = path.join(fixture, 'payload')
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true })
  const nodeRelative = nativeOS === 'win' ? '.runtime/node/node.exe' : '.runtime/node/bin/node'
  const node = path.join(tree, nodeRelative)
  fs.mkdirSync(path.dirname(node), { recursive: true })
  fs.copyFileSync(process.execPath, node)
  fs.chmodSync(node, 0o755)
  fs.writeFileSync(path.join(tree, 'payload.txt'), 'new engine')
  fs.writeFileSync(path.join(tree, '.hermes-source-commit'), commit + '\n')
  fs.writeFileSync(path.join(tree, 'scripts/build-runtime-bundle.mjs'), [
    'import fs from "node:fs"; import path from "node:path";',
    'const root=process.argv[process.argv.indexOf("--root")+1];',
    'if(process.argv[2]==="verify" && fs.readFileSync(path.join(root,"payload.txt"),"utf8")!=="new engine") throw new Error("fixture payload checksum mismatch");',
    'if(process.argv[2]==="fixup") fs.writeFileSync(path.join(root,"relocated.txt"),root);'
  ].join('\n'))
  const indexed = [nodeRelative, 'scripts/build-runtime-bundle.mjs', '.hermes-source-commit', 'payload.txt']

  const index = indexed.map(relative => {
    const bytes = fs.readFileSync(path.join(tree, relative))

    return `${relative}\tfile\t${bytes.length}\t${sha(bytes)}`
  }).join('\n') + '\n'

  fs.mkdirSync(path.join(tree, '.runtime'), { recursive: true })
  fs.writeFileSync(path.join(tree, '.runtime/files.tsv'), index)
  manifest = {
    schema: 1, kind: 'apexnodes-runtime-bundle', framework: 'hermes-agent', key: commit.slice(0, 12), runtime_commit: commit,
    os: nativeOS, arch: process.arch, min_desktop_version: '0.17.31',
    components: { python: { path: '.runtime/py/cpython-3.11.15' }, venv: { path: 'venv', relocatable: true, uv_version: '0.11.28' }, node: { path: '.runtime/node' } },
    fixup: { script: 'scripts/build-runtime-bundle.mjs', mutates: ['relocated.txt'] },
    files_index: { path: '.runtime/files.tsv', sha256: sha(index) }
  }
  fs.writeFileSync(path.join(tree, '.bundle-manifest.json'), JSON.stringify(manifest))
  fs.mkdirSync(directory, { recursive: true })
  const name = `runtime-bundle-${commit.slice(0, 12)}-${nativeOS}-${process.arch}.tar.gz`
  const archive = path.join(directory, name)
  execFileSync(tar, ['-czf', archive, '-C', tree, '.'], { timeout: 60_000 })
  manifest.archive = { name, size: fs.statSync(archive).size, sha256: sha(fs.readFileSync(archive)) }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(release))
}, 60_000)

afterAll(() => { if (fixture) {fs.rmSync(fixture, { recursive: true, force: true })} })

async function withHome(run: (home: string, options: PackagedRuntimeOptions) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bundled-home-'))

  const options: PackagedRuntimeOptions = {
    resourcesPath: resources, hermesHome: home, desktopVersion: '0.17.37',
    extract: async (archive, target) => { await exec(tar, ['-xzf', archive, '-C', target]) },
    runTool: async (executable, args) => { await exec(executable, args, { cwd: os.tmpdir(), timeout: 10_000 }) },
    probe: async root => {
      assert.equal(fs.readFileSync(path.join(root, 'payload.txt'), 'utf8'), 'new engine')
      assert.equal(fs.readFileSync(path.join(root, '.hermes-source-commit'), 'utf8').trim(), commit)
      assert.equal(fs.realpathSync(fs.readFileSync(path.join(root, 'relocated.txt'), 'utf8')), fs.realpathSync(root))
    },
    writeMarker: descriptor => fs.writeFileSync(path.join(home, 'hermes-agent', '.hermes-bootstrap-complete'), JSON.stringify({ schemaVersion: 1, pinnedCommit: descriptor.runtime_commit, version: descriptor.runtime_version }))
  }

  try { await run(home, options) } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

function legacy(home: string, source = 'f'.repeat(40), version = 'v2026.9.22-fork.ffffffff') {
  const root = path.join(home, 'hermes-agent')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '.hermes-source-commit'), source)
  fs.writeFileSync(path.join(root, '.hermes-bootstrap-complete'), JSON.stringify({ schemaVersion: 1, pinnedCommit: source, version }))
  fs.writeFileSync(path.join(root, 'old-engine.txt'), 'old runtime is usable')

  return root
}

nativeTest('the actual idle scan excludes its owned probe but blocks a live borrowed engine worker without killing it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-idle-native-'))
  const root = path.join(home, 'verified-engine')
  const active = path.join(home, 'previous-engine')
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const interpreter = process.env.HERMES_PYTHON || path.join(path.dirname(commonGit), '.venv', nativeOS === 'win' ? 'Scripts/python.exe' : 'bin/python')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: home, PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<void> | undefined

  try {
    const identity = await exec(interpreter, ['-c', 'import json,pathlib,psutil,sys; assert sys.version_info[:2] == (3,11); print(json.dumps({"psutil":str(pathlib.Path(psutil.__file__).parent),"version":psutil.__version__}))'], { env, cwd: home, timeout: 10_000 })
    const dependency = JSON.parse(identity.stdout)
    assert.ok(dependency.version, 'native fixture must have real psutil')
    await exec(interpreter, ['-m', 'venv', '--without-pip', path.join(root, 'venv')], { env, cwd: home, timeout: 20_000 })
    const python = path.join(root, 'venv', nativeOS === 'win' ? 'Scripts/python.exe' : 'bin/python')
    const purelib = await exec(python, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { env, cwd: home, timeout: 10_000 })
    fs.cpSync(dependency.psutil, path.join(purelib.stdout.trim(), 'psutil'), { recursive: true })
    fs.mkdirSync(active)
    fs.writeFileSync(path.join(active, 'old-engine.txt'), 'untouched previous engine')
    const idle = await assertPackagedRuntimeIdle(active, root)
    assert.ok(idle && idle.ownedProbePid > 0 && idle.workerPid > 0)
    assert.deepEqual(idle.holderPids, [])

    if (process.platform === 'win32') {
      assert.notEqual(idle.ownedProbePid, idle.workerPid, 'the real venv redirector must differ from its Python worker')
      assert.ok(idle.rawHolderPids.includes(idle.ownedProbePid), 'native Windows must reproduce the scanner launcher holder')
    }

    child = spawn(process.execPath, ['-e', 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)'], { cwd: active, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    closed = new Promise(resolve => child!.once('close', () => resolve()))
    const worker = child

    const ready = await new Promise<{ pid: number }>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('controlled borrowed worker did not become ready')), 5000)
      worker.once('error', error => { clearTimeout(timer); reject(error) })
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`controlled borrowed worker exited early: ${code}`)) })
      worker.stdout!.on('data', bytes => {
        output += bytes

        if (output.includes('\n')) {
          clearTimeout(timer)

          try { resolve(JSON.parse(output.split('\n')[0])) } catch (error) { reject(error) }
        }
      })
    })

    assert.equal(ready.pid, child.pid)
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0)
    await assert.rejects(assertPackagedRuntimeIdle(active, root), (error: Error & { idleProof?: typeof idle }) => {
      assert.equal((error as Error & { code: string }).code, 'runtime_update_busy')
      assert.ok(error.message.includes(String(ready.pid)), 'recovery must identify the actual blocking process')
      assert.ok(error.idleProof?.holderPids.includes(ready.pid), 'the actual borrowed PID must remain a blocker')

      return true
    })
    assert.equal(child.exitCode, null)
    assert.doesNotThrow(() => process.kill(ready.pid, 0), 'the idle scan must never kill the borrowed worker')
    assert.deepEqual((await assertPackagedRuntimeIdle(active, root, { ownedBackendPids: [ready.pid] }))?.holderPids, [], 'preflight exempts the exact owned backend that will be drained')
    await assert.rejects(assertPackagedRuntimeIdle(active, root, { ownedBackendPids: [process.pid] }), { code: 'runtime_update_busy' }, 'an arbitrary current-app child is not automatically an owned engine')
    child.kill('SIGTERM')
    let timer: NodeJS.Timeout | undefined

    try {
      await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controlled borrowed worker did not retire')), 5000) })])
    } finally { clearTimeout(timer) }

    assert.deepEqual((await assertPackagedRuntimeIdle(active, root))?.holderPids, [])
    assert.equal(fs.readFileSync(path.join(active, 'old-engine.txt'), 'utf8'), 'untouched previous engine')
  } finally {
    if (child && closed) {
      if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL')}
      let timer: NodeJS.Timeout | undefined

      try {
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controlled borrowed worker did not retire')), 5000) })])
      } finally { clearTimeout(timer) }
    }

    fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}, 60_000)

nativeTest('offline fresh boot installs, relocates and probes the active engine before stamping', async () => {
  await withHome(async (home, options) => {
    const probes: string[] = []
    const probe = options.probe!

    options.probe = async (...args) => { probes.push(args[0]); await probe(...args) }
    const result = await installPackagedRuntime(options, false)
    assert.equal(result.status, 'installed')
    assert.deepEqual(probes, [path.join(home, 'versions', commit.slice(0, 12)), path.join(home, 'hermes-agent')])
    const marker = JSON.parse(fs.readFileSync(path.join(home, 'hermes-agent', '.hermes-bootstrap-complete'), 'utf8'))

    const update = await checkForRuntimeUpdate({
      apiBase: 'https://owned-fixture.invalid', marker,
      fetchJson: async () => ({ version: release.runtime_version, cos_tarball_url: `https://owned-fixture.invalid/hermes-agent-${commit}.tar.gz`, cos_publish_status: 'published' })
    })

    assert.equal(update.updateAvailable, false, 'actual full-commit marker must match the published latest engine')
    assert.equal(marker.pinnedCommit, commit)
    assert.equal(marker.version, release.runtime_version)
    assert.equal(layout.readPointer(home).key, commit.slice(0, 12))
  })
})

nativeTest('a live engine holder defers a real native bundle transaction; release activates it without user retry', async () => {
  await withHome(async (home, options) => {
    const active = legacy(home)
    const oldMarker = fs.readFileSync(path.join(active, '.hermes-bootstrap-complete'))
    const scanRoot = path.join(home, 'scanner')
    fs.mkdirSync(scanRoot)
    const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
    const python = process.env.HERMES_PYTHON || path.join(path.dirname(commonGit), '.venv', nativeOS === 'win' ? 'Scripts/python.exe' : 'bin/python')
    fs.symlinkSync(path.dirname(path.dirname(python)), path.join(scanRoot, 'venv'), process.platform === 'win32' ? 'junction' : 'dir')
    const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], { cwd: active, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    let reportBusy!: () => void
    const blocked = new Promise<void>(resolve => { reportBusy = resolve })
    let reportInstalled!: () => void
    let reportFailure!: (error: Error) => void
    const completed = new Promise<void>((resolve, reject) => { reportInstalled = resolve; reportFailure = reject })
    const check = async () => {
      try { await assertPackagedRuntimeIdle(active, scanRoot) }
      catch (error) { reportBusy(); throw error }
    }
    options.beforeSwitch = check
    const retry = createDeferredRuntimeUpdate({
      preflight: check,
      install: async () => (await installPackagedRuntime(options, true)).status === 'installed',
      activated: reportInstalled,
      log: message => reportFailure(new Error(message)),
      retryMs: 25
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await once(child.stdout!, 'data')
      retry.schedule()
      await blocked
      assert.deepEqual(fs.readFileSync(path.join(active, '.hermes-bootstrap-complete')), oldMarker)
      assert.equal(fs.readFileSync(path.join(active, 'old-engine.txt'), 'utf8'), 'old runtime is usable')
      assert.equal(child.exitCode, null)
      child.kill()
      await closed
      await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('deferred native activation timed out')), 20_000) })])
      assert.equal(layout.readPointer(home).key, commit.slice(0, 12))
      assert.equal(fs.readFileSync(path.join(active, '.hermes-source-commit'), 'utf8').trim(), commit)
      assert.equal(fs.readFileSync(path.join(home, 'hermes-agent.legacy', 'old-engine.txt'), 'utf8'), 'old runtime is usable')
    } finally {
      clearTimeout(timeout)
      retry.dispose()
      if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL')}
      await closed
    }
  })
}, 30_000)

nativeTest('old f8 upgrades automatically while user chat/config/profile files and rollback tree remain exact', async () => {
  await withHome(async (home, options) => {
    legacy(home)
    const files = ['config.yaml', '.env', 'state.db', 'sessions/chat.json', 'profiles/oracle/config.yaml']

    for (const file of files) {
      const destination = path.join(home, file)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, `private fixture ${file}`)
    }

    assert.equal((await installPackagedRuntime(options, true)).status, 'installed')

    for (const file of files) {assert.equal(fs.readFileSync(path.join(home, file), 'utf8'), `private fixture ${file}`)}
    assert.equal(fs.readFileSync(path.join(home, 'hermes-agent.legacy', 'old-engine.txt'), 'utf8'), 'old runtime is usable')
    assert.equal(layout.readPointer(home).previous, 'legacy-inplace')
  })
})

nativeTest('same bundled source repeats actual verification; a committed marker does not hide corrupt payload', async () => {
  await withHome(async (home, options) => {
    await installPackagedRuntime(options, false)
    assert.equal((await installPackagedRuntime(options, true)).status, 'current')
    fs.writeFileSync(path.join(home, 'hermes-agent', 'payload.txt'), 'damaged payload')
    await assert.rejects(installPackagedRuntime(options, true), /fixture payload checksum mismatch/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'hermes-agent', '.hermes-bootstrap-complete'), 'utf8')).pinnedCommit, commit)
  })
})

nativeTest('fresh installation verifies staging and final path once each, while committed reuse revalidates', async () => {
  await withHome(async (home, options) => {
    const labels: string[] = []
    const run = options.runTool!
    options.runTool = async (executable, args, label) => {
      if (args[1] === 'verify') {labels.push(label)}
      await run(executable, args, label)
    }
    await installPackagedRuntime(options, false)
    assert.deepEqual(labels, ['verify', 'verify-final'])
    labels.length = 0
    layout.removeLinkOnly(path.join(home, 'hermes-agent'))
    fs.rmSync(path.join(home, '.apexnodes-runtime-current.json'))
    await installPackagedRuntime(options, false)
    assert.deepEqual(labels, ['verify-final-boot'])
  })
})

nativeTest('unreferenced committed final directory is verified before it can become active', async () => {
  await withHome(async (home, options) => {
    await installPackagedRuntime(options, false)
    layout.removeLinkOnly(path.join(home, 'hermes-agent'))
    fs.rmSync(path.join(home, '.apexnodes-runtime-current.json'))
    fs.writeFileSync(path.join(home, 'versions', commit.slice(0, 12), 'payload.txt'), 'bad reuse')
    await assert.rejects(installPackagedRuntime(options, false), /fixture payload checksum mismatch/)
    assert.equal(fs.existsSync(path.join(home, 'hermes-agent')), false)
    assert.equal(fs.existsSync(path.join(home, '.apexnodes-runtime-current.json')), false)
  })
})

nativeTest('failed active probe and marker commit restore old runtime directory and original pointer bytes', async () => {
  for (const failure of ['active-probe', 'marker']) {
    await withHome(async (home, options) => {
      const old = legacy(home)
      const originalMarker = fs.readFileSync(path.join(old, '.hermes-bootstrap-complete'))
      const originalPointer = '{"schemaVersion":1,"key":"legacy-inplace","previous":null,"switchedAt":"original"}\n'
      fs.writeFileSync(path.join(home, '.apexnodes-runtime-current.json'), originalPointer)
      const probe = options.probe!

      options.probe = async (...args) => {
        await probe(...args)

        if (failure === 'active-probe' && args[0] === old) {throw new Error('active probe fault')}
      }

      if (failure === 'marker') {options.writeMarker = () => { throw new Error('marker persistence fault') }}
      await assert.rejects(installPackagedRuntime(options, true), /fault/)
      assert.equal(fs.lstatSync(old).isDirectory(), true)
      assert.equal(fs.readFileSync(path.join(old, 'old-engine.txt'), 'utf8'), 'old runtime is usable')
      assert.deepEqual(fs.readFileSync(path.join(old, '.hermes-bootstrap-complete')), originalMarker)
      assert.equal(fs.readFileSync(path.join(home, '.apexnodes-runtime-current.json'), 'utf8'), originalPointer)
      assert.equal(fs.existsSync(path.join(home, 'hermes-agent.legacy')), false)
    })
  }
})

nativeTest.each(['worker', 'quit', 'runtime-data'])('%s refuses activation without altering the old engine', async failure => {
    await withHome(async (home, options) => {
      const old = legacy(home)

      if (failure === 'worker') {options.beforeSwitch = async () => { throw new Error('live worker') }}

      if (failure === 'quit') {
        let assertions = 0

        options.assertCurrent = () => { if (++assertions === 2) {throw new Error('quitting')} }
      }

      if (failure === 'runtime-data') {fs.writeFileSync(path.join(old, 'config.yaml'), 'runtime-local user config')}
      await assert.rejects(installPackagedRuntime(options, true), /live worker|quitting|user-data-in-runtime-dir/)
      assert.equal(fs.lstatSync(old).isDirectory(), true)
      assert.equal(fs.existsSync(path.join(home, '.apexnodes-runtime-current.json')), false)
      assert.equal(fs.readFileSync(path.join(old, 'old-engine.txt'), 'utf8'), 'old runtime is usable')
    })
})

nativeTest('newer or unknown healthy engine is preserved, including a lying version marker', async () => {
  await withHome(async (home, options) => {
    const old = legacy(home, 'e'.repeat(40), 'v2026.10.2-fork.eeeeeeee')

    options.extract = async () => { throw new Error('must not extract') }
    assert.equal((await installPackagedRuntime(options, true)).status, 'preserved')
    fs.writeFileSync(path.join(old, '.hermes-bootstrap-complete'), JSON.stringify({ pinnedCommit: 'e'.repeat(40), version: null }))
    assert.equal((await installPackagedRuntime(options, true)).status, 'preserved')
    fs.writeFileSync(path.join(old, '.hermes-bootstrap-complete'), JSON.stringify({ pinnedCommit: 'a'.repeat(40), version: 'v2020.1.1-fork.aaaaaaaa' }))
    assert.equal(packagedRuntimeDecision(old, release, true), 'preserve')
    assert.equal((await installPackagedRuntime(options, true)).status, 'preserved')
    assert.equal(fs.existsSync(path.join(home, 'versions')), false)
  })
})

nativeTest('an explicitly confirmed source can replace a same-day engine without ordering commit hashes', async () => {
  for (const previous of ['1'.repeat(40), 'f'.repeat(40)]) {
    await withHome(async (home, options) => {
      const root = legacy(home, previous, `v2026.10.1-fork.${previous.slice(0, 8)}`)
      fs.writeFileSync(path.join(home, 'state.db'), 'existing user database')
      assert.equal((await installPackagedRuntime(options, true)).status, 'preserved')
      assert.equal((await installPackagedRuntime({ ...options, confirmedRuntimeCommit: 'e'.repeat(40) }, true)).status, 'preserved')
      assert.equal(fs.readFileSync(path.join(root, '.hermes-source-commit'), 'utf8'), previous)
      const result = await installPackagedRuntime({ ...options, confirmedRuntimeCommit: commit }, true)
      assert.equal(result.status, 'installed')
      assert.equal(result.runtimeCommit, commit)
      assert.equal(fs.readFileSync(path.join(home, 'state.db'), 'utf8'), 'existing user database')
      assert.equal(fs.readFileSync(path.join(home, 'hermes-agent.legacy', '.hermes-source-commit'), 'utf8'), previous)
    })
  }
})

nativeTest('same source-only legacy install probes its actual venv before reporting current', async () => {
  await withHome(async (home, options) => {
    const old = legacy(home, commit, release.runtime_version)
    let called = false

    options.probeLegacy = async root => { assert.equal(root, old); called = true; throw new Error('legacy venv broken') }
    await assert.rejects(installPackagedRuntime(options, true), /legacy venv broken/)
    assert.equal(called, true)
    assert.equal(fs.existsSync(path.join(home, 'versions')), false)
  })
})

nativeTest('archive checksum failure cannot move a healthy old installation', async () => {
  await withHome(async (home, options) => {
    const copied = path.join(home, 'bad-resources')
    fs.cpSync(resources, copied, { recursive: true })
    options.resourcesPath = copied
    const archive = path.join(copied, 'bundled-runtime', manifest.archive.name)
    const fd = fs.openSync(archive, 'r+')
    fs.writeSync(fd, Buffer.from('bad!'), 0, 4, 8)
    fs.closeSync(fd)
    const old = legacy(home)
    await assert.rejects(installPackagedRuntime(options, true), /archive size\/checksum mismatch/)
    assert.equal(fs.lstatSync(old).isDirectory(), true)
    assert.equal(fs.existsSync(path.join(home, '.apexnodes-runtime-current.json')), false)
  })
})

nativeTest('a killed extraction leaves an owned staging slot that retry reclaims before its disk check', async () => {
  await withHome(async (home, options) => {
    const old = legacy(home)
    const staging = path.join(home, 'versions', `${commit.slice(0, 12)}.tmp`)

    const code = `
      import fs from 'node:fs'; import path from 'node:path';
      import { installPackagedRuntime } from ${JSON.stringify(pathToFileURL(path.resolve('electron/packaged-runtime.ts')).href)};
      await installPackagedRuntime({resourcesPath:${JSON.stringify(resources)},hermesHome:${JSON.stringify(home)},desktopVersion:'0.17.37',
        extract:async (_,destination)=>{fs.writeFileSync(path.join(destination,'partial-owned.bin'),'interrupted extraction'); setInterval(()=>{},1000); console.log('STAGING_STARTED'); await new Promise(()=>{});},
        runTool:async()=>{},probe:async()=>{},writeMarker:()=>{}},true);
    `

    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()) })

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('owned extraction never announced readiness')), 5000)
        let stdout = ''
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`owned extraction exited early: ${code}`)) })
        child.stdout!.on('data', bytes => {
          stdout += bytes

          if (stdout.includes('STAGING_STARTED')) {clearTimeout(timer); resolve()}
        })
      })
    } finally {child.kill('SIGKILL'); await closed}

    assert.equal(child.signalCode, 'SIGKILL', 'actual owned extraction was interrupted')

    assert.equal(fs.readFileSync(path.join(staging, 'partial-owned.bin'), 'utf8'), 'interrupted extraction')
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, '.apexnodes-bundled-staging.json'), 'utf8')).runtime_commit, commit)
    const unrelated = path.join(home, 'versions', 'unrelated.tmp')
    fs.mkdirSync(unrelated)
    fs.writeFileSync(path.join(unrelated, 'user.txt'), 'untouched')
    let checked = false

    options.freeBytesOf = () => {
      checked = true

      return fs.existsSync(staging) ? 0 : Number.MAX_SAFE_INTEGER
    }

    let result: Awaited<ReturnType<typeof installPackagedRuntime>>
    await assert.doesNotReject(async () => { result = await installPackagedRuntime(options, true) }, 'a claimed crash residue must be reclaimed before low-space refusal')
    assert.equal(result!.status, 'installed')
    assert.equal(checked, true)
    assert.equal(fs.existsSync(staging), false)
    assert.equal(fs.readFileSync(path.join(unrelated, 'user.txt'), 'utf8'), 'untouched')
    assert.equal(fs.readFileSync(path.join(home, 'hermes-agent.legacy', 'old-engine.txt'), 'utf8'), 'old runtime is usable')
    assert.ok(old.endsWith('hermes-agent'))
  })
}, 12_000)

nativeTest.each(['unowned', 'active-link', 'pointer'])('%s staging cannot be reclaimed as crash residue', async reference => {
  await withHome(async (home, options) => {
    const staging = path.join(home, 'versions', `${commit.slice(0, 12)}.tmp`)
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'user.txt'), 'must remain')

    if (reference !== 'unowned') {
      fs.writeFileSync(path.join(staging, '.apexnodes-bundled-staging.json'), JSON.stringify({ schemaVersion: 1, runtime_commit: commit, key: commit.slice(0, 12), os: nativeOS, arch: process.arch }))
    }

    if (reference === 'active-link') {layout.createActiveLink(path.join(home, 'hermes-agent'), staging)}

    if (reference === 'pointer') {fs.writeFileSync(path.join(home, '.apexnodes-runtime-current.json'), JSON.stringify({ schemaVersion: 1, key: 'previous', previous: path.basename(staging) }))}
    await assert.rejects(installPackagedRuntime(options, false), /safely reclaim/)
    assert.equal(fs.readFileSync(path.join(staging, 'user.txt'), 'utf8'), 'must remain')
  })
})

nativeTest('the measured full engine size raises the disk budget before extraction', async () => {
  await withHome(async (home, options) => {
    const copied = path.join(home, 'large-resources')
    fs.cpSync(resources, copied, { recursive: true })
    const declared = { ...manifest, files_index: { ...manifest.files_index, total_size: 4 * 1024 ** 3 } }
    fs.writeFileSync(path.join(copied, 'bundled-runtime/manifest.json'), JSON.stringify(declared))
    options.resourcesPath = copied
    // Above the existing 2.575 GiB floor, below this measured 4 GiB payload's budget.
    options.freeBytesOf = () => manifest.archive.size + 3 * 1024 ** 3

    options.extract = async () => {throw new Error('disk refusal must precede extraction')}
    await assert.rejects(installPackagedRuntime(options, false), /Not enough free disk space/)
    assert.equal(fs.existsSync(path.join(home, 'versions')), false)
  })
})

nativeTest('a too-old Desktop cannot stage or activate its bundled engine', async () => {
  await withHome(async (home, options) => {
    const old = legacy(home)
    options.desktopVersion = '0.17.30'

    options.extract = async () => { throw new Error('must refuse before extraction') }
    await assert.rejects(installPackagedRuntime(options, true), /requires Desktop 0.17.31/)
    assert.equal(fs.lstatSync(old).isDirectory(), true)
    assert.equal(fs.existsSync(path.join(home, 'versions')), false)
  })
})

nativeTest('native target, release identity, unlocked deps and archive traversal are rejected', async () => {
  await withHome(async (home, options) => {
    const directory = path.join(home, 'Resources/bundled-runtime')
    fs.mkdirSync(directory, { recursive: true })
    fs.copyFileSync(path.join(resources, 'bundled-runtime/release.json'), path.join(directory, 'release.json'))

    for (const change of [{ os: nativeOS === 'mac' ? 'win' : 'mac' }, { runtime_commit: 'b'.repeat(40) }, { dev_unlocked: true }, { archive: { ...manifest.archive, name: '../engine.tar.gz' } }]) {
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, ...change }))
      assert.throws(() => readPackagedRuntime(path.dirname(directory)), /manifest does not match/)
    }
  })
})

test('every local caller joins one install and a failed install can be retried', async () => {
  let complete: (value: { status: 'installed'; runtimeCommit: string }) => void
  let calls = 0

  const gate = createPackagedRuntimeGate(() => {
    calls++

    return new Promise(resolve => { complete = resolve })
  })

  const primary = gate()
  const pool = gate()
  const gateway = gate()
  assert.equal(primary, pool)
  assert.equal(pool, gateway)
  assert.equal(calls, 1)
  const menu = gate.waitForPending()
  gate.reset()
  assert.equal(gate(), primary, 'retry/reset must not permit a second installation during activation')
  assert.equal(menu, primary)
  complete!({ status: 'installed', runtimeCommit: commit })
  assert.equal((await gateway).runtimeCommit, commit)
  assert.equal(gate(), primary)
  let attempts = 0

  const retry = createPackagedRuntimeGate(async () => {
    if (++attempts === 1) {throw new Error('first failed')}

    return { status: 'installed', runtimeCommit: commit }
  })

  await assert.rejects(retry(), /first failed/)
  assert.equal((await retry()).status, 'installed')
  assert.equal(attempts, 2)
  let menuCalls = 0

  const notStarted = createPackagedRuntimeGate(async () => { menuCalls++;

 return { status: 'current', runtimeCommit: commit } })

  assert.equal(await notStarted.waitForPending(), null)
  assert.equal(menuCalls, 0, 'opening a menu must not initiate installation')
})

test('only canonical packaged local ownership may install; development, trial, borrowed or explicit pins cannot', () => {
  const home = path.join(os.tmpdir(), 'policy-home')
  const policy = { isPackaged: true, diagnostic: false, backendKind: 'python', backendRoot: path.join(home, 'hermes-agent'), hermesHome: home, updatePending: false }
  assert.equal(shouldInstallPackagedRuntime(policy), true)
  assert.equal(shouldInstallPackagedRuntime({ ...policy, backendKind: 'bootstrap-needed', backendRoot: undefined }), true)

  for (const change of [{ isPackaged: false }, { diagnostic: true }, { explicitRoot: '/checkout' }, { updatePending: true }, { backendRoot: '/borrowed-runtime' }, { backendRoot: undefined, backendKind: 'external' }]) {
    assert.equal(shouldInstallPackagedRuntime({ ...policy, ...change }), false)
  }
})

test('saved remote and first-run remote apply never enter the packaged local installer', async () => {
  for (const apply of [false, true]) {
    let reads = 0
    const remote = { baseUrl: 'https://owned-fixture.invalid' }

    const result = await runPrimaryBackendStartup({
      connectRemote: async value => value,
      ensureLocalRuntime: async () => { throw new Error('must not install local engine') },
      prepareLocalBackend: async () => ({ kind: 'bootstrap-needed' }),
      resolveRemote: async () => apply && reads++ === 0 ? null : remote,
      waitForDecision: async () => 'remote-applied',
      waitForLocalStart: async () => {}
    })

    assert.equal(result.kind, 'remote')
  }
})

nativeTest('runtime tools win over stale managed Node with an empty inherited PATH', () => {
  const root = path.join(fixture, 'payload')
  const environment = buildDesktopBackendEnv({ hermesHome: fixture, runtimeRoot: root, venvRoot: path.join(root, 'venv'), currentEnv: { PATH: '' } })
  const nodeRelative = nativeOS === 'win' ? '.runtime/node/node.exe' : '.runtime/node/bin/node'
  const result = execFileSync(path.join(root, nodeRelative), ['--version'], { env: environment, encoding: 'utf8' }).trim()
  assert.equal(result, process.version)
  const bins = environment.PATH.split(path.delimiter)
  assert.equal(bins[0], path.dirname(path.join(root, nodeRelative)))

  if (nativeOS === 'win') {
    assert.ok(bins.includes(path.join(root, '.runtime/git/bin')))
    assert.ok(bins.includes(path.join(root, '.runtime/git/cmd')))
  } else {
    assert.ok(bins.includes(path.join(root, '.runtime/bin')))
  }
})

nativeTest('the real terminal launcher prepends bundled tools while preserving its own interactive PATH', () => {
  const root = path.join(fixture, 'payload')
  const userBin = path.join(fixture, 'interactive-tools')
  fs.mkdirSync(userBin, { recursive: true })
  const script = path.join(fixture, nativeOS === 'win' ? 'launcher.cmd' : 'launcher.sh')
  const prefix = bundledRuntimePathEntries(root)
  fs.writeFileSync(script, buildTerminalScript({
    command: 'node', args: ['-e', 'console.log(JSON.stringify({executable:process.execPath,path:process.env.PATH}))'],
    cwd: fixture, env: terminalScriptEnv({ PATH: '/headless-should-not-leak' }), pathPrefix: prefix
  }))
  const environment: NodeJS.ProcessEnv = { PATH: userBin }

  if (nativeOS === 'win') {
    environment.SystemRoot = process.env.SystemRoot
    environment.COMSPEC = process.env.COMSPEC
  }

  const output = nativeOS === 'win'
    ? spawnSync(process.env.COMSPEC!, ['/c', script], { env: environment, encoding: 'utf8' })
    : spawnSync('/bin/sh', [script], { env: environment, encoding: 'utf8' })

  assert.equal(output.status, 0, `actual terminal launcher failed: ${output.stderr}`)
  const result = JSON.parse(output.stdout.trim())
  assert.equal(fs.realpathSync(result.executable), fs.realpathSync(path.join(root, nativeOS === 'win' ? '.runtime/node/node.exe' : '.runtime/node/bin/node')))
  assert.deepEqual(result.path.split(path.delimiter), [...prefix, userBin])
})

nativeTest.each(['mixed-source', 'rebuilt-artifact'])('%s recovers from the exact offline pin add-only', async scenario => {
  await withHome(async (home, options) => {
    assert.equal(packagedRuntimeMatchesPin(resources, commit), true)
    assert.equal(packagedRuntimeMatchesPin(resources, 'e'.repeat(40)), false)
    assert.equal(packagedRuntimeMatchesPin(resources, null), false)
    const paths = layout.bundlePaths(home)
    const oldKey = scenario === 'mixed-source' ? 'f'.repeat(12) : commit.slice(0, 12)
    const old = paths.versionDir(oldKey)
    fs.mkdirSync(old, { recursive: true })
    // The old installer left contradictory metadata while changing the source stamp.
    fs.writeFileSync(path.join(old, '.bundle-manifest.json'), JSON.stringify(scenario === 'mixed-source' ? { ...manifest, key: oldKey, runtime_commit: 'f'.repeat(40) } : { ...manifest, files_index: { ...manifest.files_index, sha256: 'a'.repeat(64) } }))
    fs.writeFileSync(path.join(old, '.hermes-source-commit'), commit)
    fs.writeFileSync(path.join(old, '.hermes-bootstrap-complete'), JSON.stringify({ pinnedCommit: commit, version: release.runtime_version }))
    fs.writeFileSync(path.join(old, 'old-engine.txt'), 'still usable but mixed dependencies')
    layout.writePointerAtomic(home, { key: oldKey, previous: 'legacy-inplace' })
    layout.createActiveLink(paths.activeLink, old)
    fs.writeFileSync(path.join(home, 'config.yaml'), 'private user configuration')
    const marker = fs.readFileSync(path.join(old, '.hermes-bootstrap-complete'))
    const override = path.join(home, '.apexnodes-runtime-override.json')
    const arm = { resourcesPath: resources, commit, branch: null, version: release.runtime_version,
      previousMarker: JSON.parse(marker.toString()), persistOverride: (value: { commit: string; previousMarker: unknown }) => fs.writeFileSync(override, JSON.stringify(value)) }

    assert.equal(armPackagedRuntimeUpdate({ ...arm, commit: 'e'.repeat(40) }), false)
    assert.equal(fs.existsSync(override), false)
    assert.equal(armPackagedRuntimeUpdate(arm), true)
    assert.deepEqual(fs.readFileSync(path.join(old, '.hermes-bootstrap-complete')), marker)
    assert.equal(JSON.parse(fs.readFileSync(override, 'utf8')).commit, commit)


    assert.equal((await installPackagedRuntime(options, true)).status, 'installed')
    assert.equal(layout.readPointer(home).key, scenario === 'mixed-source' ? commit.slice(0, 12) : `${commit.slice(0, 12)}-${manifest.files_index.sha256.slice(0, 12)}`)
    assert.equal(layout.readPointer(home).previous, oldKey)
    assert.equal(fs.readFileSync(path.join(old, 'old-engine.txt'), 'utf8'), 'still usable but mixed dependencies')
    assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), 'private user configuration')
    assert.equal((await installPackagedRuntime(options, true)).status, 'current')
  })
})


test('bundled engine owns setup from cold verification through completion and failure/retry', async () => {
  const events: Array<{ type: string; state?: string; error?: string }> = []
  let resolve!: (result: { status: 'installed'; runtimeCommit: string }) => void
  const gate = createPackagedRuntimeGate(() => new Promise(done => { resolve = done }), event => events.push(event))
  const pending = gate()
  assert.deepEqual(events.map(event => event.type), ['manifest', 'stage'])
  assert.equal(events[1].state, 'running')
  assert.equal(gate(), pending)
  assert.equal(events.length, 2, 'joining the install cannot reset its progress')
  resolve({ status: 'installed', runtimeCommit: commit })
  await pending
  assert.deepEqual(events.slice(2).map(event => [event.type, event.state]), [['stage', 'succeeded'], ['complete', undefined]])

  events.length = 0
  let attempts = 0
  const retry = createPackagedRuntimeGate(async () => {
    if (++attempts === 1) {throw new Error('checksum mismatch')}
    return { status: 'current', runtimeCommit: commit }
  }, event => events.push(event))
  await assert.rejects(retry(), /checksum mismatch/)
  assert.equal(events.at(-1)?.type, 'failed')
  assert.equal(events.at(-1)?.error, 'checksum mismatch')
  assert.equal(events.some(event => event.type === 'complete'), false)
  await retry()
  assert.deepEqual(events.slice(-4).map(event => event.type), ['manifest', 'stage', 'stage', 'complete'])
})
