import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

import { DEFAULT_INSTALL_MIN_FREE_BYTES, INSTALL_SAFETY_MARGIN_BYTES, preflightDiskSpace } from './apex-bundle-diskspace'
import {
  bundledNodeExe,
  bundledToolScript,
  checkMinDesktopVersion,
  parseBundleManifest,
  stageAndCommitBundle,
  verifyArgv
} from './apex-bundle-install'
import * as layout from './apex-bundle-layout'
import * as migrate from './apex-bundle-migrate'
import { compareSemver } from './apex-runtime-latest'
import { buildDesktopBackendEnv } from './backend-env'

const exec = promisify(execFile)
const SOURCE_STAMP = '.hermes-source-commit'
const MARKER = '.hermes-bootstrap-complete'
const STAGING_OWNER = '.apexnodes-bundled-staging.json'

export interface PackagedRuntimeRelease {
  schemaVersion: 1
  runtime_commit: string
  runtime_version: string
  min_desktop_version: string
  uv_version: string
}

export interface PackagedRuntimeOptions {
  resourcesPath: string
  hermesHome: string
  desktopVersion: string
  platform?: NodeJS.Platform
  arch?: string
  extract: (archive: string, destination: string) => Promise<void>
  runTool: (executable: string, args: string[], label: string) => Promise<void>
  probe?: (root: string, release: PackagedRuntimeRelease) => Promise<void>
  probeLegacy?: (root: string, release: PackagedRuntimeRelease) => Promise<void>
  beforeSwitch?: (verifiedRoot: string) => Promise<void>
  writeMarker: (release: PackagedRuntimeRelease) => void
  assertCurrent?: () => void
  log?: (message: string) => void
  freeBytesOf?: (root: string) => number
}

export interface PackagedRuntimeResult {
  status: 'installed' | 'current' | 'preserved'
  reason?: 'newer-or-unknown' | 'upgrade-failed'
  runtimeCommit: string | null
}

function readJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function relativeFile(root: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') || path.posix.isAbsolute(relative)) {
    throw new Error('Bundled engine contains an unsafe relative path.')
  }

  return path.join(root, ...relative.split('/'))
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')

  for await (const bytes of fs.createReadStream(file)) {
    hash.update(bytes)
  }

  return hash.digest('hex')
}

function nativeTarget(platform: NodeJS.Platform, arch: string) {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {return { os: 'mac', arch }}

  if (platform === 'win32' && arch === 'x64') {return { os: 'win', arch }}
  throw new Error(`The packaged engine does not support ${platform}/${arch}.`)
}

export function shouldInstallPackagedRuntime({ isPackaged, diagnostic, explicitRoot, backendRoot, backendKind, hermesHome, updatePending }: {
  isPackaged: boolean
  diagnostic: boolean
  explicitRoot?: string
  backendRoot?: string
  backendKind: string
  hermesHome: string
  updatePending: boolean
}) {
  return isPackaged && !diagnostic && !explicitRoot && !updatePending &&
    (backendKind === 'bootstrap-needed' || Boolean(backendRoot && path.resolve(backendRoot) === layout.bundlePaths(hermesHome).activeLink))
}

export function readPackagedRuntime(resourcesPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const resources = path.join(resourcesPath, 'bundled-runtime')
  const release = readJson(path.join(resources, 'release.json')) as PackagedRuntimeRelease | null

  if (!release || release.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(release.runtime_commit) || !/^v\d{4}\.\d{1,2}\.\d{1,2}-fork\.[a-f0-9]+$/.test(release.runtime_version) || !/^\d+\.\d+\.\d+$/.test(release.min_desktop_version) || !release.uv_version) {
    throw new Error('The installer is missing a valid bundled engine release descriptor.')
  }

  const target = nativeTarget(platform, arch)
  const manifest = parseBundleManifest(readJson(path.join(resources, 'manifest.json')))
  const key = release.runtime_commit.slice(0, 12)
  const archiveName = `runtime-bundle-${key}-${target.os}-${target.arch}.tar.gz`

  if (manifest.key !== key || manifest.runtime_commit !== release.runtime_commit || manifest.os !== target.os || manifest.arch !== target.arch || manifest.dev_unlocked === true || manifest.archive.name !== archiveName || !Number.isSafeInteger(manifest.archive.size) || manifest.archive.size <= 0 || !/^[a-f0-9]{64}$/.test(manifest.archive.sha256) || manifest.min_desktop_version !== release.min_desktop_version || manifest.components?.venv?.relocatable !== true || manifest.components?.venv?.uv_version !== release.uv_version || manifest.components?.node?.path !== '.runtime/node' || manifest.fixup?.script !== 'scripts/build-runtime-bundle.mjs' || !/^[a-f0-9]{64}$/.test(manifest.files_index.sha256)) {
    throw new Error('The bundled engine manifest does not match its release/platform identity.')
  }

  relativeFile(resources, manifest.archive.name)
  relativeFile(resources, manifest.files_index.path)
  relativeFile(resources, manifest.components.python.path)

  return { release, manifest, archivePath: path.join(resources, archiveName) }
}

/** The opt-in update can reuse the offline payload only for the exact requested source pin. */
export function packagedRuntimeMatchesPin(resourcesPath: string, commit: string | null | undefined): boolean {
  if (!commit) {return false}

  try { return readPackagedRuntime(resourcesPath).release.runtime_commit === commit } catch { return false }
}

/** Arm an offline update without deleting the old ordering/rollback marker. */
export function armPackagedRuntimeUpdate(options: {
  resourcesPath: string
  commit: string | null
  branch: string | null
  version: string | null
  previousMarker: unknown
  persistOverride: (override: { commit: string; branch: string | null; version: string | null; previousMarker: unknown }) => void
}): boolean {
  if (!options.commit || !packagedRuntimeMatchesPin(options.resourcesPath, options.commit)) {return false}
  options.persistOverride({ commit: options.commit, branch: options.branch, version: options.version, previousMarker: options.previousMarker })

  return true
}

function actualCommit(root: string): string | null {
  try {
    const value = fs.readFileSync(path.join(root, SOURCE_STAMP), 'utf8').trim()

    return /^[a-f0-9]{40}$/.test(value) ? value : null
  } catch {
    return null
  }
}

/** A marker may provide ordering only when the actual installed source agrees. */
export function packagedRuntimeDecision(root: string, release: PackagedRuntimeRelease, usable: boolean) {
  const commit = actualCommit(root)

  if (!usable) {return 'install' as const}

  if (commit === release.runtime_commit) {
    // Older shells could overwrite an active bundle with source while leaving its old
    // bundle metadata behind. Recover add-only into the requested bundle's own directory.
    const embedded = readJson(path.join(root, '.bundle-manifest.json'))

    return embedded && (embedded.runtime_commit !== commit || embedded.key !== commit.slice(0, 12)) ? 'install' as const : 'current' as const
  }
  const marker = readJson(path.join(root, MARKER))
  const matches = commit && typeof marker?.pinnedCommit === 'string' && marker.pinnedCommit.length >= 7 && commit.startsWith(marker.pinnedCommit)
  const order = matches && /^v\d{4}\.\d{1,2}\.\d{1,2}-fork\.[a-f0-9]+$/.test(marker.version) ? compareSemver(marker.version, release.runtime_version) : null

  return order !== null && order < 0 ? 'install' as const : 'preserve' as const
}

/** Bind the executable verifier to the hash-checked installer manifest, even on reuse. */
async function verifyToolIdentity(root: string, manifest: ReturnType<typeof parseBundleManifest>) {
  const embedded = parseBundleManifest(readJson(path.join(root, '.bundle-manifest.json')), { requireArchive: false })

  for (const field of ['key', 'runtime_commit', 'os', 'arch', 'components', 'fixup', 'files_index']) {
    if (!isDeepStrictEqual(embedded[field], manifest[field])) {
      throw new Error(`The installed bundled engine has a different ${field}.`)
    }
  }

  if (actualCommit(root) !== manifest.runtime_commit) {throw new Error('Bundled engine source stamp mismatch.')}
  const index = relativeFile(root, manifest.files_index.path)

  if (await sha256(index) !== manifest.files_index.sha256) {throw new Error('Bundled engine file index mismatch.')}

  const rows = new Map(fs.readFileSync(index, 'utf8').trimEnd().split('\n').map(line => {
    const [relative, type, size, digest] = line.split('\t')

    return [relative, { type, size: Number(size), digest }] as const
  }))

  for (const file of [bundledNodeExe(root, manifest), bundledToolScript(root, manifest), path.join(root, SOURCE_STAMP)]) {
    const row = rows.get(path.relative(root, file).split(path.sep).join('/'))

    if (!row || row.type !== 'file' || fs.statSync(file).size !== row.size || await sha256(file) !== row.digest) {
      throw new Error('Bundled engine verifier/source bytes do not match the installer index.')
    }
  }
}

function probeEnv(root: string, home: string): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}

  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'LANG']) {
    if (process.env[key]) {inherited[key] = process.env[key]}
  }

  return {
    ...inherited,
    ...buildDesktopBackendEnv({ hermesHome: home, runtimeRoot: root, venvRoot: path.join(root, 'venv'), pythonPathEntries: [root], currentEnv: inherited }),
    HOME: home,
    USERPROFILE: home,
    HERMES_HOME: home,
    UV_OFFLINE: '1',
    PIP_NO_INDEX: '1',
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_INSTALL_TELEMETRY: '0',
    HERMES_DASHBOARD_DISABLE_AUTH: '0'
  }
}

// Pinned Python 3.11's Windows platform.machine() reads optional PROCESSOR_* hints.
// Verify the interpreter's compiled platform and pointer width instead.
export const NATIVE_PYTHON_ARCHITECTURE_PROBE = [
  'import platform,struct,sys,sysconfig',
  'if sys.platform == "win32":',
  ' assert sys.argv[3] == "x64" and sysconfig.get_platform() == "win-amd64" and struct.calcsize("P") == 8, "engine architecture mismatch"',
  'else:',
  ' assert platform.machine().lower() in ({"arm64","aarch64"} if sys.argv[3] == "arm64" else {"amd64","x86_64"}), "engine architecture mismatch"'
].join('\n')

export async function probePackagedRuntime(root: string, release: PackagedRuntimeRelease, bundled = true): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-engine-probe-'))
  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

  const code = [
    'import pathlib,sys',
    'root=pathlib.Path(sys.argv[1]).resolve()',
    'assert sys.version_info[:2] == (3,11), "engine Python version mismatch"',
    'assert pathlib.Path(sys.prefix).resolve() == root / "venv", "engine venv mismatch"',
    'if sys.argv[4] == "bundled": assert pathlib.Path(sys.base_prefix).resolve().is_relative_to(root / ".runtime" / "py"), "engine Python is not bundled"',
    'import yaml,dotenv,hermes_cli.config,hermes_cli.main,run_agent,toolsets',
    'assert pathlib.Path(hermes_cli.config.__file__).resolve().is_relative_to(root), "engine imported foreign source"',
    'assert (root / ".hermes-source-commit").read_text().strip() == sys.argv[2], "engine source mismatch"',
    NATIVE_PYTHON_ARCHITECTURE_PROBE
  ].join('\n')

  try {
    await exec(python, ['-c', code, root, release.runtime_commit, process.arch, bundled ? 'bundled' : 'legacy'], { cwd: home, env: probeEnv(root, home), windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 })
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

/** Shared runtime workers must leave before the canonical path can change. Never kills borrowed workers. */
export async function assertPackagedRuntimeIdle(activeRoot: string, verifiedRoot: string) {
  if (!fs.existsSync(activeRoot)) {return null}
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-engine-holder-'))
  const python = path.join(verifiedRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

  const code = [
    'import json,os,pathlib,psutil,sys',
    'roots={os.path.normcase(os.path.abspath(sys.argv[1])),os.path.normcase(os.path.realpath(sys.argv[1]))}',
    'def under(value):',
    ' if not value or not os.path.isabs(value): return False',
    ' candidate=os.path.normcase(os.path.abspath(value))',
    ' return any(candidate == root or candidate.startswith(root+os.sep) for root in roots)',
    'holders=[]',
    'for p in psutil.process_iter():',
    ' if p.pid == os.getpid(): continue',
    ' try:',
    '  if under(p.exe()) or under(p.cwd()) or any(under(arg) for arg in p.cmdline()): holders.append(p.pid)',
    ' except psutil.NoSuchProcess: continue',
    ' except psutil.AccessDenied: continue',
    'print(json.dumps({"holders":holders,"workerPid":os.getpid()}))'
  ].join('\n')

  try {
    const pending = exec(python, ['-c', code, activeRoot], { cwd: home, env: probeEnv(verifiedRoot, home), windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 })
    const ownedProbePid = pending.child.pid
    const { stdout } = await pending
    const result = JSON.parse(stdout)

    if (typeof ownedProbePid !== 'number' || !Number.isInteger(ownedProbePid) || ownedProbePid <= 0 || !Number.isInteger(result.workerPid) || result.workerPid <= 0 ||
      !Array.isArray(result.holders) || result.holders.some((pid: unknown) => !Number.isInteger(pid) || Number(pid) <= 0)) {
      throw new Error('Could not verify existing engine workers.')
    }

    // Windows venv Python has a live redirector parent carrying our activeRoot argument.
    // Exclude only the exact process Node launched for this scan, never other ancestors/workers.
    const holderPids = result.holders.filter((pid: number) => pid !== ownedProbePid)
    const idleProof = { ownedProbePid, workerPid: result.workerPid as number, rawHolderPids: result.holders as number[], holderPids: holderPids as number[] }

    if (holderPids.length) {
      throw Object.assign(new Error('The previous engine is still running. Close its local workers and retry; no engine files were switched.'), { idleProof })
    }

    return idleProof
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

function snapshotActivation(hermesHome: string) {
  const { activeLink, pointerPath } = layout.bundlePaths(hermesHome)
  const status = layout.linkStatus(activeLink)

  return {
    status,
    pointer: fs.existsSync(pointerPath) ? fs.readFileSync(pointerPath) : null,
    target: status.kind === 'link' ? fs.realpathSync(activeLink) : null
  }
}

function restoreActivation(hermesHome: string, before: ReturnType<typeof snapshotActivation>) {
  const { activeLink, pointerPath } = layout.bundlePaths(hermesHome)
  const aside = migrate.legacyAsidePath(hermesHome)

  if (before.status.kind === 'dir' && fs.existsSync(aside)) {
    if (!layout.removeLinkOnly(activeLink)) {throw new Error('Could not remove the failed engine link during rollback.')}
    fs.renameSync(aside, activeLink)
  } else if (before.status.kind === 'link' && before.target) {
    if (!layout.removeLinkOnly(activeLink)) {throw new Error('Could not restore the previous engine link.')}
    layout.createActiveLink(activeLink, before.target)
  } else if (before.status.kind === 'missing') {
    if (layout.linkStatus(activeLink).kind !== 'missing' && !layout.removeLinkOnly(activeLink)) {throw new Error('Could not undo the failed first engine activation.')}
  }

  if (before.pointer) {
    const temporary = `${pointerPath}.${process.pid}.rollback`
    fs.writeFileSync(temporary, before.pointer)
    fs.renameSync(temporary, pointerPath)
  } else {
    fs.rmSync(pointerPath, { force: true })
  }
}

function reclaimOwnedPackagedStaging(hermesHome: string, manifest: ReturnType<typeof parseBundleManifest>, directoryKey = manifest.key) {
  const paths = layout.bundlePaths(hermesHome)
  const staging = paths.stagingDir(directoryKey)

  if (!fs.existsSync(staging)) {return}
  const status = fs.lstatSync(staging)
  const owner = readJson(path.join(staging, STAGING_OWNER))
  const pointer = layout.readPointer(hermesHome)

  if (!status.isDirectory() || status.isSymbolicLink() ||
    (typeof process.getuid === 'function' && status.uid !== process.getuid()) ||
    owner?.schemaVersion !== 1 || owner.runtime_commit !== manifest.runtime_commit || owner.key !== manifest.key || owner.os !== manifest.os || owner.arch !== manifest.arch ||
    (fs.existsSync(paths.pointerPath) && !pointer) || [pointer?.key, pointer?.previous].includes(path.basename(staging)) ||
    layout.linkResolvesTo(paths.activeLink, staging)) {
    throw new Error('Could not safely reclaim the bundled engine temporary directory; the previous engine was preserved.')
  }

  // Only this package's claimed, unreferenced staging slot. No committed version GC.
  fs.rmSync(staging, { recursive: true, maxRetries: 6, retryDelay: 100 })
}

/** No network, no in-place extraction, no GC of the old rollback target. */
export async function installPackagedRuntime(options: PackagedRuntimeOptions, existingUsable: boolean): Promise<PackagedRuntimeResult> {
  const { hermesHome, desktopVersion, extract, runTool, writeMarker, assertCurrent = () => {} } = options

  const log = (message: string) => { try { options.log?.(message) } catch { /* Logging cannot undo a committed engine. */ } }
  const { release, manifest, archivePath } = readPackagedRuntime(options.resourcesPath, options.platform, options.arch)
  const activeRoot = layout.bundlePaths(hermesHome).activeLink
  let decision = packagedRuntimeDecision(activeRoot, release, existingUsable)
  const installed = readJson(path.join(activeRoot, '.bundle-manifest.json'))

  if (decision === 'current' && installed && !isDeepStrictEqual(installed.files_index, manifest.files_index)) {
    decision = 'install'
  }

  if (decision === 'preserve') {
    log('[bundled-engine] preserving the installed engine: no proven older source/version.')

    return { status: 'preserved', reason: 'newer-or-unknown', runtimeCommit: actualCommit(activeRoot) }
  }

  if (!checkMinDesktopVersion(manifest, desktopVersion).ok) {throw new Error(`The bundled engine requires Desktop ${release.min_desktop_version} or later.`)}
  const probe = options.probe ?? probePackagedRuntime

  const checkedTool = async (executable: string, args: string[], label: string) => {
    const root = args[args.indexOf('--root') + 1]
    await verifyToolIdentity(root, manifest)
    await runTool(executable, args, label)
  }

  if (decision === 'current') {
    // A source-only legacy install may not have bundle metadata; still probe its actual venv.
    if (fs.existsSync(path.join(activeRoot, '.bundle-manifest.json'))) {
      await verifyToolIdentity(activeRoot, manifest)
      await checkedTool(bundledNodeExe(activeRoot, manifest), verifyArgv(activeRoot, manifest), 'verify-current')
      await probe(activeRoot, release)
    } else {
      await (options.probeLegacy ?? ((root, descriptor) => probePackagedRuntime(root, descriptor, false)))(activeRoot, release)
    }

    assertCurrent()
    writeMarker(release)

    return { status: 'current', runtimeCommit: release.runtime_commit }
  }

  if (fs.statSync(archivePath).size !== manifest.archive.size || await sha256(archivePath) !== manifest.archive.sha256) {
    throw new Error('Bundled engine archive size/checksum mismatch.')
  }

  fs.mkdirSync(hermesHome, { recursive: true })
  const base = layout.bundlePaths(hermesHome).versionDir(manifest.key)
  const prior = readJson(path.join(base, '.bundle-manifest.json'))
  const directoryKey = prior && !isDeepStrictEqual(prior.files_index, manifest.files_index)
    ? `${manifest.key}-${manifest.files_index.sha256.slice(0, 12)}` : manifest.key
  reclaimOwnedPackagedStaging(hermesHome, manifest, directoryKey)
  const extracted = manifest.files_index.total_size

  const minFreeBytes = Number.isSafeInteger(extracted) && extracted > 0
    ? Math.max(DEFAULT_INSTALL_MIN_FREE_BYTES, manifest.archive.size + extracted + INSTALL_SAFETY_MARGIN_BYTES)
    : undefined

  const disk = preflightDiskSpace({ hermesHome, archiveSize: manifest.archive.size, minFreeBytes, freeBytesOf: options.freeBytesOf })

  if (!disk.ok) {throw new Error('Not enough free disk space to safely stage the bundled engine and retain the previous engine.')}
  assertCurrent()

  const staged = await stageAndCommitBundle({
    hermesHome, key: manifest.key, directoryKey, archivePath, manifest,
    extract: async (archive, destination) => {
      fs.writeFileSync(path.join(destination, STAGING_OWNER), JSON.stringify({ schemaVersion: 1, runtime_commit: manifest.runtime_commit, key: manifest.key, os: manifest.os, arch: manifest.arch }), { flag: 'wx', mode: 0o600 })
      await extract(archive, destination)
    },
    runTool: checkedTool, log
  })

  // stageAndCommitBundle skips its verifier for committed trees: repeat actual verification on every reuse.
  await verifyToolIdentity(staged.versionDir, manifest)
  await checkedTool(bundledNodeExe(staged.versionDir, manifest), verifyArgv(staged.versionDir, manifest), 'verify-final-boot')
  await probe(staged.versionDir, release)
  await options.beforeSwitch?.(staged.versionDir)
  assertCurrent()
  const before = snapshotActivation(hermesHome)

  try {
    const switched = migrate.switchToVersionOrMigrate(hermesHome, directoryKey)

    if (!switched.ok || switched.linkPending || !layout.linkResolvesTo(activeRoot, staged.versionDir)) {
      throw new Error(`Bundled engine activation did not complete (${switched.reason || 'active-link-pending'}).`)
    }

    await probe(activeRoot, release)
    assertCurrent()

    if (actualCommit(activeRoot) !== release.runtime_commit) {throw new Error('The active engine source does not match the installed bundle.')}
    writeMarker(release)
    log(`[bundled-engine] activated ${release.runtime_version} (${release.runtime_commit})`)

    return { status: 'installed', runtimeCommit: release.runtime_commit }
  } catch (error) {
    restoreActivation(hermesHome, before)
    throw error
  }
}

/** All local spawn callers await the same installation; a failed attempt is retryable. */
export function createPackagedRuntimeGate(run: () => Promise<PackagedRuntimeResult>) {
  let pending: Promise<PackagedRuntimeResult> | null = null
  let running = false

  const ensure = () => {
    if (!pending) {
      running = true
      pending = run().catch(error => {
        pending = null
        throw error
      }).finally(() => { running = false })
    }

    return pending
  }

  return Object.assign(ensure, {
    // Menus can wait for boot without initiating a first install themselves.
    waitForPending: () => pending ?? Promise.resolve(null),
    reset: () => { if (!running) {pending = null} }
  })
}
