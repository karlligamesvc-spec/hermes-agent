import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { assertBundledRuntimePackage, readBundledRuntimePin, sha256File, stageBundledRuntime } from './bundled-runtime-package.mjs'

function fixture(root, { platform = 'darwin', arch = 'arm64', omit = '', embeddedCommit, mutate = () => {}, pythonVersion = '3.11.15' } = {}) {
  const pin = readBundledRuntimePin()
  const osName = platform === 'win32' ? 'win' : 'mac'
  const key = pin.runtime_commit.slice(0, 12)
  const out = path.join(root, 'out')
  const source = path.join(root, 'source')
  const python = `.runtime/py/cpython-${pythonVersion}-${osName}-${arch}`
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
    osName === 'win' ? `${python}/python.exe` : `${python}/bin/python${pythonVersion.split('.').slice(0, 2).join('.')}`, manifest.components.uv.path, manifest.components.ripgrep.path,
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

test('hc-911: the bundled interpreter path follows the bundle python version', () => {
  for (const pythonVersion of ['3.11.15', '3.14.7']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-package-'))
    try {
      const f = fixture(root, { pythonVersion })
      assert.equal(stageBundledRuntime(f.out, f.resources, f.options).runtimeCommit, f.options.pin.runtime_commit)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-package-'))
    try {
      const series = pythonVersion.split('.').slice(0, 2).join('.')
      const f = fixture(missing, { pythonVersion, omit: `.runtime/py/cpython-${pythonVersion}-mac-arm64/bin/python${series}` })
      assert.throws(() => stageBundledRuntime(f.out, f.resources, f.options), new RegExp(`missing .*python${series.replace('.', '\\.')}`))
    } finally { fs.rmSync(missing, { recursive: true, force: true }) }
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

// hc-1033: the shell installs over a listed engine with no marker proof, so a wrong row could replace
// an engine newer than the pin. The format and date rules run everywhere; git ancestry (the real
// proof) runs wherever the commits are present, which excludes CI's shallow checkouts. Run this file
// in a full clone after editing bundled-runtime.json.
test('hc-1033: every engine the pin supersedes is a git ancestor of it', t => {
  const pin = readBundledRuntimePin()
  const repository = path.resolve(import.meta.dirname, '../../..')
  const git = (...args) => spawnSync('git', ['-C', repository, '--no-lazy-fetch', ...args], { encoding: 'utf8' })
  const listed = Object.keys(pin.supersedes || {})
  assert.ok(listed.length > 0, 'the pin lists the engines it replaces')
  if (git('cat-file', '-e', `${pin.runtime_commit}^{commit}`).status !== 0) {
    t.skip('this checkout lacks the pinned commit (shallow clone); ancestry needs a full clone')
    return
  }
  const notAncestors = listed.filter(commit => git('merge-base', '--is-ancestor', commit, pin.runtime_commit).status !== 0)
  assert.deepEqual(notAncestors, [])
})

test('hc-1033: a supersedes row must name its own commit, never the pin, and never a later day', () => {
  const pin = readBundledRuntimePin()
  const [listed, label] = Object.entries(pin.supersedes)[0]
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-supersedes-'))
  const read = supersedes => {
    const file = path.join(root, 'bundled-runtime.json')
    fs.writeFileSync(file, JSON.stringify({ ...pin, supersedes }))
    return readBundledRuntimePin(file)
  }
  try {
    assert.deepEqual(read({ [listed]: label }).supersedes, { [listed]: label })
    assert.equal(read(undefined).supersedes, undefined)
    for (const supersedes of [
      [listed],
      { [listed]: label.replace(/fork\.[0-9a-f]{8}$/, 'fork.ffffffff') },
      { [pin.runtime_commit]: pin.runtime_version },
      { [listed.slice(0, 12)]: label },
      { [listed]: label.replace(/^v\d{4}\.\d+\.\d+/, 'v2099.1.1') }
    ]) {
      assert.throws(() => read(supersedes), /supersedes/)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
