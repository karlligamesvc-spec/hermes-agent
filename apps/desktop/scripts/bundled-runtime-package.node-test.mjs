import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { assertBundledRuntimePackage, readBundledRuntimePin, sha256File, stageBundledRuntime } from './bundled-runtime-package.mjs'

function fixture(root, { platform = 'darwin', arch = 'arm64', omit = '', embeddedCommit, mutate = () => {} } = {}) {
  const pin = readBundledRuntimePin()
  const osName = platform === 'win32' ? 'win' : 'mac'
  const key = pin.runtime_commit.slice(0, 12)
  const out = path.join(root, 'out')
  const source = path.join(root, 'source')
  const python = `.runtime/py/cpython-3.11.15-${osName}-${arch}`
  const manifest = {
    schema: 1, kind: 'apexnodes-runtime-bundle', framework: 'hermes-agent', key,
    runtime_commit: pin.runtime_commit, min_desktop_version: pin.min_desktop_version, os: osName, arch,
    components: {
      python: { path: python }, venv: { path: 'venv', relocatable: true, sync: 'uv sync --extra all --locked', uv_version: pin.uv_version },
      node: { path: '.runtime/node' }, uv: { path: `.runtime/bin/uv${osName === 'win' ? '.exe' : ''}` },
      ripgrep: { path: `.runtime/bin/rg${osName === 'win' ? '.exe' : ''}` },
      ...(osName === 'win' ? { git: { path: '.runtime/git', flavor: 'PortableGit', shell: 'bin/bash.exe' } } : {})
    },
    fixup: { script: 'scripts/build-runtime-bundle.mjs' }, files_index: { sha256: 'a'.repeat(64) },
    // Synthetic receipts isolate the packaging boundary. Native release jobs
    // separately execute and assess every real payload; these fixtures do not.
    ...(osName === 'mac' ? { mac_signing: { hardened_runtime: true, macho_files: 4 }, mac_notarization: { status: 'Accepted', submission_id: 'fixture', issues: [] } } : {})
  }
  const files = [
    '.bundle-manifest.json', '.hermes-source-commit', '.runtime/files.tsv', 'scripts/build-runtime-bundle.mjs', 'pyproject.toml', 'uv.lock',
    osName === 'win' ? 'venv/Scripts/python.exe' : 'venv/bin/python',
    osName === 'win' ? '.runtime/node/node.exe' : '.runtime/node/bin/node',
    osName === 'win' ? `${python}/python.exe` : `${python}/bin/python3.11`, manifest.components.uv.path, manifest.components.ripgrep.path,
    ...(osName === 'win' ? ['.runtime/git/bin/bash.exe', '.runtime/git/cmd/git.exe'] : [])
  ]
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  for (const file of files) {
    if (file === omit) continue
    const absolute = path.join(source, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, file === '.hermes-source-commit' ? `${embeddedCommit || pin.runtime_commit}\n` : 'fixture')
  }
  fs.writeFileSync(path.join(source, '.bundle-manifest.json'), JSON.stringify(manifest))
  const archive = path.join(out, `runtime-bundle-${key}-${osName}-${arch}.tar.gz`)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const result = spawnSync(tar, ['-czf', archive, '-C', source, '.'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  manifest.archive = { name: path.basename(archive), size: fs.statSync(archive).size, sha256: sha256File(archive) }
  mutate(manifest)
  fs.writeFileSync(path.join(out, path.basename(archive).replace('.tar.gz', '.manifest.json')), JSON.stringify(manifest))
  return { out, resources: path.join(root, 'resources'), options: { platform, arch, pin }, archive, manifest }
}

test('staging ships the matching native archive and refuses actual copied-byte corruption', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-package-'))
    try {
      const f = fixture(root, { platform, arch })
      const proof = stageBundledRuntime(f.out, f.resources, f.options)
      assert.equal(proof.runtimeCommit, f.options.pin.runtime_commit)
      assert.equal(proof.runtimeVersion, f.options.pin.runtime_version)
      assert.equal(proof.sha256, sha256File(f.archive))
      const copied = path.join(f.resources, 'bundled-runtime', path.basename(f.archive))
      const bytes = fs.readFileSync(copied)
      bytes[0] ^= 1
      fs.writeFileSync(copied, bytes)
      assert.throws(() => assertBundledRuntimePackage(f.resources, platform, arch, f.options.pin), /size or SHA256 mismatch/)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('a source-only, unlocked, mismatched or unnotarized payload cannot become an installer resource', () => {
  const cases = [
    { mutate: m => { m.dev_unlocked = true }, message: /source, compatibility or native target mismatch/ },
    { mutate: m => { m.runtime_commit = 'b'.repeat(40) }, message: /source, compatibility or native target mismatch/ },
    { mutate: m => { m.arch = 'x64' }, message: /source, compatibility or native target mismatch/ },
    { mutate: m => { m.mac_notarization.status = 'Invalid' }, message: /signed and notarized/ },
    { mutate: m => { m.mac_notarization.issues = [{ severity: 'error' }] }, message: /signed and notarized/ },
    { omit: 'venv/bin/python', message: /archive is missing venv\/bin\/python/ },
    { embeddedCommit: 'b'.repeat(40), message: /embedded source stamp differs/ },
    { platform: 'win32', arch: 'x64', mutate: m => { m.components.git.flavor = 'MinGit' }, message: /portable Bash shell/ },
    { platform: 'win32', arch: 'x64', omit: '.runtime/git/bin/bash.exe', message: /archive is missing .runtime\/git\/bin\/bash.exe/ }
  ]
  for (const input of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-package-reject-'))
    try {
      const f = fixture(root, input)
      assert.throws(() => stageBundledRuntime(f.out, f.resources, f.options), input.message)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})
