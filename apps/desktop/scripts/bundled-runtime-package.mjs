import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { removeOwnedRuntimeTree } from '../../../scripts/runtime-bundle-offline-smoke.mjs'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(desktopRoot, '../..')
const pinFile = path.join(desktopRoot, 'bundled-runtime.json')

export function readBundledRuntimePin(file = pinFile) {
  const pin = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (pin.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(pin.runtime_commit) ||
      !/^v\d{4}\.\d+\.\d+-fork\.[0-9a-f]{8}$/.test(pin.runtime_version) ||
      !pin.runtime_version.endsWith(pin.runtime_commit.slice(0, 8)) ||
      !/^\d+\.\d+\.\d+$/.test(pin.min_desktop_version) || !/^\d+\.\d+\.\d+$/.test(pin.uv_version)) {
    throw new Error('Invalid bundled runtime release pin')
  }
  return pin
}

export function sha256File(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const bytes = Buffer.alloc(4 * 1024 * 1024)
  try {
    let count
    while ((count = fs.readSync(fd, bytes, 0, bytes.length)) > 0) hash.update(bytes.subarray(0, count))
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

export function validateBundledRuntimeManifest(manifest, pin, platform, arch) {
  const osName = { darwin: 'mac', win32: 'win' }[platform]
  const key = pin.runtime_commit.slice(0, 12)
  if (!osName || !['arm64', 'x64'].includes(arch) || (osName === 'win' && arch !== 'x64')) {
    throw new Error(`Unsupported bundled runtime target ${platform}-${arch}`)
  }
  if (manifest.schema !== 1 || manifest.kind !== 'apexnodes-runtime-bundle' || manifest.framework !== 'hermes-agent') {
    throw new Error('Invalid bundled runtime manifest schema')
  }
  if (manifest.dev_unlocked || manifest.runtime_commit !== pin.runtime_commit || manifest.key !== key ||
      manifest.min_desktop_version !== pin.min_desktop_version || manifest.os !== osName || manifest.arch !== arch) {
    throw new Error('Bundled runtime source, compatibility or native target mismatch')
  }
  const archiveName = `runtime-bundle-${key}-${osName}-${arch}.tar.gz`
  if (manifest.archive?.name !== archiveName || !Number.isSafeInteger(manifest.archive.size) || manifest.archive.size <= 0 ||
      !/^[0-9a-f]{64}$/.test(manifest.archive.sha256 || '')) {
    throw new Error('Invalid bundled runtime archive identity')
  }
  const components = manifest.components
  if (!/^\.runtime\/py\/cpython-[A-Za-z0-9_.-]+$/.test(components?.python?.path || '') || components.venv?.relocatable !== true ||
      components.venv.path !== 'venv' || components.venv.sync !== 'uv sync --extra all --locked' || components.venv.uv_version !== pin.uv_version || components.node?.path !== '.runtime/node' ||
      components.uv?.path !== `.runtime/bin/uv${osName === 'win' ? '.exe' : ''}` ||
      components.ripgrep?.path !== `.runtime/bin/rg${osName === 'win' ? '.exe' : ''}` ||
      manifest.fixup?.script !== 'scripts/build-runtime-bundle.mjs' || !/^[0-9a-f]{64}$/.test(manifest.files_index?.sha256 || '')) {
    throw new Error('Bundled runtime is missing runnable, relocatable components')
  }
  if (osName === 'win' && (components.git?.path !== '.runtime/git' || components.git.flavor !== 'PortableGit' || components.git.shell !== 'bin/bash.exe')) {
    throw new Error('Windows bundled runtime is missing its portable Bash shell')
  }
  if (osName === 'mac' && (!manifest.mac_signing?.hardened_runtime || manifest.mac_signing.macho_files < 1 ||
      manifest.mac_notarization?.status !== 'Accepted' || !manifest.mac_notarization.submission_id ||
      !Array.isArray(manifest.mac_notarization.issues) || manifest.mac_notarization.issues.length)) {
    throw new Error('Mac bundled runtime payload must be signed and notarized')
  }
  return { archiveName, osName, key }
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.status}`)
  return result.stdout
}

function tarBinary() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

export function assertBundledRuntimePackage(resources, platform, arch, pin = readBundledRuntimePin()) {
  const root = path.join(resources, 'bundled-runtime')
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'))
  for (const field of Object.keys(pin)) {
    if (release[field] !== pin[field]) throw new Error(`Bundled runtime release pin differs at ${field}`)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  const identity = validateBundledRuntimeManifest(manifest, pin, platform, arch)
  const archive = path.join(root, identity.archiveName)
  if (fs.statSync(archive).size !== manifest.archive.size || sha256File(archive) !== manifest.archive.sha256) {
    throw new Error('Bundled runtime archive size or SHA256 mismatch')
  }
  const files = new Set(run(tarBinary(), ['-tzf', archive], { capture: true }).split(/\r?\n/).map(file => file.replace(/^\.\//, '')))
  const required = [
    '.bundle-manifest.json', '.hermes-source-commit', '.runtime/files.tsv', 'scripts/build-runtime-bundle.mjs', 'pyproject.toml', 'uv.lock',
    manifest.os === 'win' ? 'venv/Scripts/python.exe' : 'venv/bin/python',
    manifest.os === 'win' ? '.runtime/node/node.exe' : '.runtime/node/bin/node',
    manifest.os === 'win' ? `${manifest.components.python.path}/python.exe` : `${manifest.components.python.path}/bin/python3.11`,
    manifest.components.uv.path, manifest.components.ripgrep.path,
    ...(manifest.os === 'win' ? ['.runtime/git/bin/bash.exe', '.runtime/git/cmd/git.exe'] : [])
  ]
  for (const file of required) if (!files.has(file)) throw new Error(`Bundled runtime archive is missing ${file}`)
  const source = run(tarBinary(), ['-xOzf', archive, './.hermes-source-commit'], { capture: true }).trim()
  if (source !== pin.runtime_commit) throw new Error('Bundled runtime embedded source stamp differs from its release pin')
  const embedded = JSON.parse(run(tarBinary(), ['-xOzf', archive, './.bundle-manifest.json'], { capture: true }))
  for (const field of ['schema', 'kind', 'framework', 'key', 'runtime_commit', 'os', 'arch']) {
    if (embedded[field] !== manifest[field]) throw new Error(`Bundled runtime embedded manifest differs at ${field}`)
  }
  if (embedded.files_index?.sha256 !== manifest.files_index.sha256) throw new Error('Bundled runtime embedded index identity differs')
  return { ...identity, runtimeCommit: pin.runtime_commit, runtimeVersion: pin.runtime_version, size: manifest.archive.size, sha256: manifest.archive.sha256 }
}

export function stageBundledRuntime(outDir, buildResources = path.join(desktopRoot, 'build'), { platform = process.platform, arch = process.arch, pin = readBundledRuntimePin() } = {}) {
  const basename = `runtime-bundle-${pin.runtime_commit.slice(0, 12)}-${platform === 'win32' ? 'win' : 'mac'}-${arch}`
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, `${basename}.manifest.json`), 'utf8'))
  validateBundledRuntimeManifest(manifest, pin, platform, arch)
  const staged = path.join(buildResources, 'bundled-runtime')
  removeOwnedRuntimeTree(staged)
  fs.mkdirSync(staged, { recursive: true })
  fs.copyFileSync(path.join(outDir, manifest.archive.name), path.join(staged, manifest.archive.name))
  fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(staged, 'release.json'), JSON.stringify(pin, null, 2) + '\n')
  return assertBundledRuntimePackage(buildResources, platform, arch, pin)
}

function build(outDir, notarize) {
  const pin = readBundledRuntimePin()
  const builder = path.join(repositoryRoot, 'scripts', 'build-runtime-bundle.mjs')
  const commit = spawnSync('git', ['cat-file', '-e', `${pin.runtime_commit}^{commit}`], { cwd: repositoryRoot })
  if (commit.status !== 0) run('git', ['-C', repositoryRoot, 'fetch', '--no-tags', '--depth', '1', 'origin', pin.runtime_commit])
  const args = [builder, 'build', '--ref', pin.runtime_commit, '--out', outDir,
    '--min-desktop-version', pin.min_desktop_version, '--uv-version', pin.uv_version]
  if (process.platform === 'darwin') {
    const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true })
    const identity = identities.match(/"(Developer ID Application:[^"]+)"/)?.[1]
    if (!identity || !notarize) throw new Error('Mac installer runtime requires a Developer ID certificate and --notarize')
    args.push('--mac-sign-identity', identity, '--mac-notarize')
  }
  run(process.execPath, args)
  const osName = process.platform === 'win32' ? 'win' : 'mac'
  const archive = path.join(outDir, `runtime-bundle-${pin.runtime_commit.slice(0, 12)}-${osName}-${process.arch}.tar.gz`)
  run(process.execPath, [builder, 'smoke', '--archive', archive, '--workdir', path.join(outDir, 'relocation-smoke')])
  const proof = stageBundledRuntime(outDir)
  fs.writeFileSync(path.join(outDir, 'packaged-runtime-proof.json'), JSON.stringify(proof, null, 2) + '\n')
  console.log(`Bundled runtime ready: ${JSON.stringify(proof)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second, third] = process.argv.slice(2)
  try {
    if (command === 'build') build(path.resolve(first || path.join(os.tmpdir(), 'apex-bundled-runtime')), second === '--notarize')
    else if (command === 'stage') console.log(JSON.stringify(stageBundledRuntime(path.resolve(first))))
    else if (command === 'assert') console.log(JSON.stringify(assertBundledRuntimePackage(path.resolve(first), second, third)))
    else throw new Error('Usage: bundled-runtime-package.mjs build <OUT> [--notarize] | stage <OUT> | assert <RESOURCES> <PLATFORM> <ARCH>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
