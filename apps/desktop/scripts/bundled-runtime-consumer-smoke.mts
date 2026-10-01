import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { removeOwnedRuntimeTree, runtimeSmokeEnvironment, terminateOwnedSmokeProcess } from '../../../scripts/runtime-bundle-offline-smoke.mjs'
import { bundledNodeExe, fixupArgv } from '../electron/apex-bundle-install.ts'
import { checkForRuntimeUpdate } from '../electron/apex-runtime-latest.ts'
import { buildDesktopBackendEnv } from '../electron/backend-env.ts'
import { waitForDashboardPortAnnouncement } from '../electron/backend-ready.ts'
import { ModelMutationMetadataStore } from '../electron/desktop-model-mutations.ts'
import {
  assertPackagedRuntimeIdle,
  installPackagedRuntime,
  type PackagedRuntimeOptions,
  probePackagedRuntime,
  readPackagedRuntime
} from '../electron/packaged-runtime.ts'

// This entry runs only owned temp homes, no Electron, provider calls or network installers.
// CI prepares the genuine historical Git object before this offline consumer gate.
const F8 = 'f8d9cbebee9baa018cf8a8866ecb896e9f70fa5a'
const F8_VERSION = 'v2026.9.22-fork.f8d9cbeb'
const exec = promisify(execFile)
const args = process.argv.slice(2)
const option = (key: string) => args[args.indexOf(key) + 1]
assert.ok(args.includes('--resources') && args.includes('--proof'), 'Usage: node --import tsx scripts/bundled-runtime-consumer-smoke.mts --resources build --proof OUT/consumer-proof.json [--legacy-source SOURCE]')
const resourcesPath = path.resolve(option('--resources'))
const proofPath = path.resolve(option('--proof'))
const legacySource = args.includes('--legacy-source') ? path.resolve(option('--legacy-source')) : null
const { release, manifest } = readPackagedRuntime(resourcesPath)
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-engine-consumer-'))
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'System32', 'tar.exe') : '/usr/bin/tar'
const cleanEnv: NodeJS.ProcessEnv = {}

for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'LANG']) {
  if (process.env[key]) {cleanEnv[key] = process.env[key]}
}

function environment(root: string, home: string) {
  const offline = runtimeSmokeEnvironment(root, home, manifest)

  return {
    ...cleanEnv,
    ...buildDesktopBackendEnv({ runtimeRoot: root, hermesHome: home, venvRoot: path.join(root, 'venv'), pythonPathEntries: [root], currentEnv: cleanEnv }),
    HOME: home, USERPROFILE: home, HERMES_HOME: home,
    UV_OFFLINE: offline.UV_OFFLINE || '1', PIP_NO_INDEX: offline.PIP_NO_INDEX || '1',
    HERMES_DISABLE_LAZY_INSTALLS: offline.HERMES_DISABLE_LAZY_INSTALLS || '1',
    PYTHONPATH: offline.PYTHONPATH, TMPDIR: offline.TMPDIR, TMP: offline.TMP, TEMP: offline.TEMP,
    ...(process.platform === 'win32' ? { APPDATA: offline.APPDATA, LOCALAPPDATA: offline.LOCALAPPDATA } : {}),
    PYTHONDONTWRITEBYTECODE: '1', APEXNODES_TELEMETRY: 'off', HERMES_INSTALL_TELEMETRY: '0'
  }
}

const python = (root: string) => path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const proof: Record<string, unknown> = { schemaVersion: 1, platform: process.platform, arch: process.arch, release, fresh: null, legacy: null, success: false }
let cleanupFailure: unknown

function consumer(home: string): PackagedRuntimeOptions {
  return {
    resourcesPath, hermesHome: home, desktopVersion: '0.17.37',
    extract: async (archive, destination) => { await exec(tar, ['-xzf', archive, '-C', destination], { timeout: 180_000 }) },
    runTool: async (executable, argv) => {
      const root = argv[argv.indexOf('--root') + 1]
      assert.ok(argv.includes('--root') && path.isAbsolute(root), 'bundle tool must declare its actual root')
      await exec(executable, argv, { cwd: workspace, env: environment(root, workspace), timeout: 180_000, maxBuffer: 1024 * 1024 })
    },
    beforeSwitch: async verifiedRoot => { await assertPackagedRuntimeIdle(path.join(home, 'hermes-agent'), verifiedRoot) },
    writeMarker: descriptor => {
      const marker = path.join(home, 'hermes-agent', '.hermes-bootstrap-complete')
      const temporary = `${marker}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, pinnedCommit: descriptor.runtime_commit, pinnedBranch: null, version: descriptor.runtime_version, desktopVersion: '0.17.37' }))
      fs.renameSync(temporary, marker)
    }
  }
}

async function rpc(root: string, home: string) {
  const token = randomBytes(24).toString('hex')

  const child = spawn(python(root), ['-m', 'hermes_cli.main', 'serve', '--isolated', '--skip-build', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: { ...environment(root, home), HERMES_DASHBOARD_SESSION_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })

  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))

  let output = ''
  child.stdout!.on('data', bytes => { output = (output + bytes).slice(-8192) })
  child.stderr!.on('data', bytes => { output = (output + bytes).slice(-8192) })

  try {
    const port = await waitForDashboardPortAnnouncement(child, { timeoutMs: 90_000, bufferedOutput: () => output })
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200, 'actual engine HTTP status')
    const status = await response.json()
    assert.equal(typeof status.version, 'string')
    assert.ok(status.version.length > 0, 'actual runtime must expose its version')
    const capability = await fetch(`http://127.0.0.1:${port}/api/model/mutation`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    assert.equal(capability.status, 200)
    const target = await capability.json()
    assert.equal(target.version, 1)
    assert.match(target.target_id, /^[a-f0-9-]{36}$/)
    assert.equal(fs.readFileSync(path.join(root, '.hermes-source-commit'), 'utf8').trim(), release.runtime_commit)

    return { status: response.status, runtimeCommit: release.runtime_commit, runtimeVersion: status.version, targetId: target.target_id, actualPid: child.pid, interpreter: python(root), externalPythonSocketsDenied: true }
  } finally {
    await terminateOwnedSmokeProcess(child, closed)
  }
}

async function seedOld(home: string, dependencies: string) {
  const root = path.join(home, 'hermes-agent')
  const { stdout: gitRoot } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  const repository = gitRoot.trim()
  assert.ok(path.isAbsolute(repository), 'historical source must use the actual Git repository root')
  fs.mkdirSync(root, { recursive: true })

  if (legacySource) {
    // Never copy .env/config/session/user files from a historical user tree.
    const forbidden = new Set(['.env', 'config.yaml', 'config.yml', 'sessions', 'memory', 'seed_memory', 'seed_memory.json', 'workspace', '.hermes-bootstrap-complete'])
    fs.cpSync(legacySource, root, { recursive: true, filter: source => !forbidden.has(path.relative(legacySource, source).split(path.sep)[0]) })
    assert.equal(fs.readFileSync(path.join(root, '.hermes-source-commit'), 'utf8').trim(), F8)
  } else {
    await exec('git', ['cat-file', '-e', `${F8}^{commit}`], { cwd: repository, env: process.env })
    const archive = path.join(workspace, 'genuine-f8-source.tar')
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, F8], { cwd: repository })
    await exec(tar, ['-xf', archive, '-C', root])

    for (const relative of ['venv', '.runtime', 'node_modules']) {
      const source = path.join(dependencies, relative)

      if (fs.existsSync(source)) {fs.cpSync(source, path.join(root, relative), { recursive: true })}
    }

    // Dependency relocation only; historical tracked source remains the genuine F8 archive.
    fs.writeFileSync(path.join(root, '.bundle-manifest.json'), JSON.stringify(manifest))
    await exec(bundledNodeExe(dependencies, manifest), fixupArgv(root, manifest).map((argument, index) => index === 0 ? path.join(dependencies, manifest.fixup.script) : argument), {
      cwd: workspace, env: environment(root, home), timeout: 60_000, maxBuffer: 1024 * 1024
    })
    fs.rmSync(path.join(root, '.bundle-manifest.json'))
    fs.writeFileSync(path.join(root, '.hermes-source-commit'), F8 + '\n')
  }

  assert.ok(fs.existsSync(path.join(root, 'hermes_cli/main.py')), 'genuine historical archive must contain the Runtime CLI at its repository root')
  const original = await exec('git', ['show', `${F8}:hermes_cli/main.py`], { cwd: repository, maxBuffer: 1024 * 1024 })
  assert.equal(sha(fs.readFileSync(path.join(root, 'hermes_cli/main.py'))), sha(Buffer.from(original.stdout)), 'genuine F8 CLI source hash')
  fs.writeFileSync(path.join(root, '.hermes-bootstrap-complete'), JSON.stringify({ schemaVersion: 1, pinnedCommit: F8, version: F8_VERSION, desktopVersion: '0.17.31' }))
  await probePackagedRuntime(root, { ...release, runtime_commit: F8, runtime_version: F8_VERSION }, false)

  return { root, runtimeCommit: F8, version: F8_VERSION, cliSha256: sha(fs.readFileSync(path.join(root, 'hermes_cli/main.py'))), genuineGitSource: true, actualImports: true }
}

async function stateRows(root: string, home: string) {
  const { stdout } = await exec(python(root), ['-c', 'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"; print(json.dumps({"sessions":db.execute("SELECT id,source FROM sessions WHERE id=?",("consumer-fixture",)).fetchall(),"messages":db.execute("SELECT session_id,role,content FROM messages WHERE session_id=? ORDER BY id",("consumer-fixture",)).fetchall()}))', path.join(home, 'state.db')], { cwd: workspace, env: environment(root, home), timeout: 10_000 })

  return JSON.parse(stdout)
}

async function assertNoUpdate(home: string) {
  const marker = JSON.parse(fs.readFileSync(path.join(home, 'hermes-agent', '.hermes-bootstrap-complete'), 'utf8'))

  const latest = await checkForRuntimeUpdate({
    apiBase: 'https://owned-fixture.invalid', marker,
    fetchJson: async () => ({ version: release.runtime_version, cos_tarball_url: `https://owned-fixture.invalid/hermes-agent-${release.runtime_commit}.tar.gz`, cos_publish_status: 'published' })
  })

  assert.equal(latest.updateAvailable, false, 'installed full source identity must not offer the same engine again')

  return { marker, updateAvailable: latest.updateAvailable, publishedKey: latest.latest.key }
}

async function verifyRuntimeIdleGate(verifiedRoot: string) {
  const active = path.join(workspace, 'idle-control-engine')
  fs.mkdirSync(active)
  const marker = path.join(active, 'unchanged-engine.txt')
  fs.writeFileSync(marker, 'controlled old engine')
  const noWorker = await assertPackagedRuntimeIdle(active, verifiedRoot)
  assert.ok(noWorker && noWorker.ownedProbePid > 0 && noWorker.workerPid > 0)
  assert.deepEqual(noWorker.holderPids, [])

  let reversal: unknown = null

  if (process.platform === 'win32') {
    assert.notEqual(noWorker.ownedProbePid, noWorker.workerPid, 'actual venv launcher and Python worker must be distinct')
    assert.ok(noWorker.rawHolderPids.includes(noWorker.ownedProbePid), 'the actual scanner redirector must reproduce the old false holder')
    const sourcePath = fileURLToPath(new URL('../electron/packaged-runtime.ts', import.meta.url))
    const original = fs.readFileSync(sourcePath)
    const anchor = 'const holderPids = result.holders.filter((pid: number) => pid !== ownedProbePid)'
    const body = original.toString('utf8')
    assert.equal(body.split(anchor).length - 1, 1, 'private reversal must target the unique actual idle PID filter')
    const copy = path.join(path.dirname(sourcePath), `packaged-runtime.idle-reverse-${randomUUID()}.ts`)
    const reversed = body.replace(anchor, 'const holderPids = result.holders')
    fs.writeFileSync(copy, reversed, { flag: 'wx' })
    assert.equal(fs.readFileSync(copy, 'utf8'), reversed, 'private fault must be the actual imported bytes')

    try {
      const code = `import assert from 'node:assert/strict'; import { assertPackagedRuntimeIdle } from ${JSON.stringify(pathToFileURL(copy).href)};
try { await assert.doesNotReject(() => assertPackagedRuntimeIdle(${JSON.stringify(active)},${JSON.stringify(verifiedRoot)}),'native idle control must accept no foreign worker'); }
catch(error) { console.log(JSON.stringify({name:error.name,code:error.code,idleProof:error.actual?.idleProof})); throw error; }`

      let observed: unknown
      await assert.rejects(exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        cwd: path.dirname(sourcePath), env: environment(verifiedRoot, workspace), windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024
      }), error => {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string }
        assert.equal(failure.code, 1, 'the private native control must really fail')
        assert.match(failure.stderr || '', /AssertionError \[ERR_ASSERTION\]/)
        const result = JSON.parse(failure.stdout || '')
        assert.equal(result.name, 'AssertionError')
        assert.equal(result.code, 'ERR_ASSERTION')
        assert.ok(result.idleProof.rawHolderPids.includes(result.idleProof.ownedProbePid), 'unfiltered actual scanner PID must cause the refusal')
        observed = { exitCode: failure.code, ...result }

        return true
      })
      reversal = { uniqueAnchor: true, importedFaultSha256: sha(Buffer.from(reversed)), actualRefusal: observed }
    } finally {
      fs.rmSync(copy, { force: true })
      assert.equal(fs.existsSync(copy), false, 'private product copy must be removed')
      assert.equal(sha(fs.readFileSync(sourcePath)), sha(original), 'tracked product bytes must never be changed by the reversal')
    }

    assert.deepEqual((await assertPackagedRuntimeIdle(active, verifiedRoot))?.holderPids, [])
  }

  const token = randomUUID()
  const node = bundledNodeExe(verifiedRoot, manifest)

  const child = spawn(node, ['-e', `console.log(JSON.stringify({pid:process.pid,token:${JSON.stringify(token)}})); setInterval(()=>{},1000)`], {
    cwd: active, env: environment(verifiedRoot, workspace), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })

  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let blocked: unknown
  let fixturePid: number | undefined

  try {
    const ready = await new Promise<{ pid: number; token: string }>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('owned idle-holder fixture did not become ready')), 5000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`owned idle-holder fixture exited early: ${code}`)) })
      child.stdout!.on('data', bytes => {
        output += bytes

        if (output.includes('\n')) {
          clearTimeout(timer)

          try { resolve(JSON.parse(output.split('\n')[0])) } catch (error) { reject(error) }
        }
      })
    })

    assert.equal(ready.token, token)
    assert.equal(ready.pid, child.pid)
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0)
    fixturePid = ready.pid
    await assert.rejects(assertPackagedRuntimeIdle(active, verifiedRoot), error => {
      const failure = error as Error & { idleProof?: typeof noWorker }
      assert.match(failure.message, /previous engine is still running/)
      assert.ok(failure.idleProof?.holderPids.includes(ready.pid), 'only the scanner PID can be excluded; the real borrowed worker must block')
      blocked = failure.idleProof

      return true
    })
    assert.equal(child.exitCode, null)
    assert.doesNotThrow(() => process.kill(ready.pid, 0), 'the idle detector must leave a borrowed process alive')
    assert.equal(fs.readFileSync(marker, 'utf8'), 'controlled old engine')
  } finally {
    await terminateOwnedSmokeProcess(child, closed)
  }

  // An owned close event can precede kernel PID retirement on Windows.
  const deadline = Date.now() + 5000
  let retired = false

  while (Date.now() < deadline) {
    try { process.kill(fixturePid!, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { retired = true;

 break }

      throw error
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  assert.equal(retired, true, 'only the recorded fixture must actually retire before retry')
  const afterRetirement = await assertPackagedRuntimeIdle(active, verifiedRoot)
  assert.deepEqual(afterRetirement?.holderPids, [])
  assert.equal(fs.readFileSync(marker, 'utf8'), 'controlled old engine')

  return { noWorker, borrowedWorker: { pid: fixturePid, stillAliveAfterRefusal: true, blocked }, afterRetirement, privateWindowsReversal: reversal }
}

try {
  const fresh = path.join(workspace, 'fresh-home')
  const first = await installPackagedRuntime(consumer(fresh), false)
  assert.equal(first.status, 'installed')
  const active = path.join(fresh, 'hermes-agent')
  const actualRpc = await rpc(active, fresh)
  assert.equal((await installPackagedRuntime(consumer(fresh), true)).status, 'current')
  proof.fresh = { ...first, actualRpc, reopen: 'current', updateCheck: await assertNoUpdate(fresh) }
  proof.runtimeIdleGate = await verifyRuntimeIdleGate(active)

  const returning = path.join(workspace, 'legacy-home')
  const before = await seedOld(returning, active)
  const userFiles = ['config.yaml', 'sessions/fixture.json', 'profiles/oracle/config.yaml', 'profiles/oracle/sessions/fixture.json']

  for (const file of userFiles) {
    const target = path.join(returning, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.endsWith('config.yaml') ? 'display:\n  language: zh\n' : JSON.stringify({ fixture: true, revision: 17, id: 'owned-fixture' }))
  }

  await exec(python(before.root), ['-c', 'import sys; from pathlib import Path; from hermes_state import SessionDB; db=SessionDB(db_path=Path(sys.argv[1])); db.create_session("consumer-fixture",source="desktop"); db.append_message("consumer-fixture","user","private fixture chat"); db.close()', path.join(returning, 'state.db')], { cwd: workspace, env: environment(before.root, returning), timeout: 30_000 })
  const authority = randomUUID()
  const counter = 'desktop-user-data/desktop-model-mutations.json'
  assert.equal(new ModelMutationMetadataStore(path.join(returning, counter), () => authority).nextProvisionRevision(), 1)
  await exec(python(active), ['-c', 'import sys; from pathlib import Path; from hermes_cli.web_model_mutations import _journal\nwith _journal(Path(sys.argv[1])) as db: db.execute("INSERT INTO revisions VALUES (?,?)",(sys.argv[2],1))', returning, authority], { cwd: workspace, env: environment(active, returning), timeout: 10_000 })
  userFiles.push(counter, `${counter}.initialized`, '.desktop-model-mutations.sqlite3')
  const fileHashes = Object.fromEntries(userFiles.map(file => [file, sha(fs.readFileSync(path.join(returning, file)))]))
  const sqliteBefore = sha(fs.readFileSync(path.join(returning, 'state.db')))
  const rows = await stateRows(before.root, returning)
  const failing = consumer(returning)

  failing.probe = async (root, descriptor) => {
    await probePackagedRuntime(root, descriptor)

    if (root === before.root) {throw new Error('owned post-switch probe fault')}
  }

  await assert.rejects(installPackagedRuntime(failing, true), /owned post-switch probe fault/)
  assert.equal(fs.lstatSync(before.root).isDirectory(), true)
  assert.equal(fs.readFileSync(path.join(before.root, '.hermes-source-commit'), 'utf8').trim(), F8)
  assert.equal(sha(fs.readFileSync(path.join(returning, 'state.db'))), sqliteBefore)
  await probePackagedRuntime(before.root, { ...release, runtime_commit: F8, runtime_version: F8_VERSION }, false)
  const upgrade = await installPackagedRuntime(consumer(returning), true)
  assert.equal(upgrade.status, 'installed')

  for (const file of userFiles) {assert.equal(sha(fs.readFileSync(path.join(returning, file))), fileHashes[file], `user state changed: ${file}`)}
  assert.equal(sha(fs.readFileSync(path.join(returning, 'state.db'))), sqliteBefore, 'SQLite bytes during installation')
  const upgraded = path.join(returning, 'hermes-agent')
  assert.deepEqual(await stateRows(upgraded, returning), rows)
  assert.equal(fs.readFileSync(path.join(returning, 'hermes-agent.legacy', '.hermes-source-commit'), 'utf8').trim(), F8)
  const upgradedRpc = await rpc(upgraded, returning)
  assert.deepEqual(await stateRows(upgraded, returning), rows)

  for (const file of [counter, `${counter}.initialized`, '.desktop-model-mutations.sqlite3']) {assert.equal(sha(fs.readFileSync(path.join(returning, file))), fileHashes[file], `mutation metadata changed: ${file}`)}
  assert.equal((await installPackagedRuntime(consumer(returning), true)).status, 'current')
  proof.legacy = { before, after: upgrade, actualRpc: upgradedRpc, reopen: 'current', updateCheck: await assertNoUpdate(returning), userFiles: fileHashes, sqliteBytesDuringInstallUnchanged: true, rowsAfterReopenUnchanged: rows, nativeCounterAndRuntimeJournalUnchanged: [counter, `${counter}.initialized`, '.desktop-model-mutations.sqlite3'], oldRollbackTreePreserved: true, injectedPostSwitchFailureRestoredUsableF8: true }
  proof.success = true
} catch (error) {
  proof.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  try {
    removeOwnedRuntimeTree(workspace)
    proof.privateWorkspaceRemoved = true
  } catch (error) {
    proof.success = false
    proof.privateWorkspaceRemoved = false
    proof.cleanupError = error instanceof Error ? error.message : String(error)
    cleanupFailure = error
  } finally {
    fs.mkdirSync(path.dirname(proofPath), { recursive: true })
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n')
  }
}

if (cleanupFailure) {throw cleanupFailure}
console.log(JSON.stringify({ success: true, platform: process.platform, arch: process.arch, runtimeCommit: release.runtime_commit, proof: proofPath }))
