#!/usr/bin/env node
// hc-906: the genuine F8 (Desktop 0.17.31-era) install for the release consumer smoke's
// "real legacy upgrade" proof.
//
// The smoke used to fake that install from F8's source plus the NEW bundle's dependencies. That stopped
// being possible with Hermes v0.22: its runtime is CPython 3.14 without PyYAML, while F8 requires
// Python <3.14 and pyyaml, so the fake tree could not run its own code ("engine Python version
// mismatch"). Real F8 users are on F8's own 3.11 runtime, so this builds exactly that, with F8's own
// builder at F8, installs it at a fixed location the way a user machine has it (fixed up for its path,
// no bundle manifest, the source-commit marker) and prints the tree for --legacy-source.
//
//   node scripts/legacy-runtime-fixture.mjs --work DIR      (prints DIR/tree on success)
//
// A cached DIR/out/<archive> is reused; the tree is always re-extracted and fixed up.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const F8 = 'f8d9cbebee9baa018cf8a8866ecb896e9f70fa5a'
// F8's builder fetches the latest uv when none is given, which would let the fixture drift. 0.11.28 is
// the uv every 3.11-era release pin carried (bundled-runtime.json before the v0.22 move to 0.12.3).
export const F8_UV_VERSION = '0.11.28'
export const F8_MIN_DESKTOP_VERSION = '0.17.31'
export const F8_PYTHON_SERIES = [3, 11]

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function f8ArchiveName(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'

  return `runtime-bundle-${F8.slice(0, 12)}-${os}-${arch}.tar.gz`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })

  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.slice(0, 2).join(' ')} failed (${result.error?.message || result.status})`)
  }

  return result
}

function buildF8Archive(work, out) {
  const source = path.join(work, 'f8-source')
  fs.rmSync(source, { recursive: true, force: true })
  // A run killed mid-build leaves the worktree registered with its directory gone.
  run('git', ['-C', repoRoot, 'worktree', 'prune'])
  run('git', ['-C', repoRoot, 'worktree', 'add', '--detach', source, F8])

  try {
    run(process.execPath, [path.join(source, 'scripts', 'build-runtime-bundle.mjs'), 'build', '--ref', F8, '--out', out,
      '--min-desktop-version', F8_MIN_DESKTOP_VERSION, '--uv-version', F8_UV_VERSION], { cwd: source })
  } finally {
    run('git', ['-C', repoRoot, 'worktree', 'remove', '--force', source])
  }
}

function installTree(archive, tree) {
  fs.rmSync(tree, { recursive: true, force: true })
  fs.mkdirSync(tree, { recursive: true })
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  run(tar, ['-xzf', archive, '-C', tree])

  // Stamp the tree for this location, as the installer did on the user's machine.
  const manifestPath = path.join(tree, '.bundle-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const node = path.join(tree, ...manifest.components.node.path.split('/'), ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']))
  run(node, [path.join(tree, ...manifest.fixup.script.split('/')), 'fixup', '--root', tree])

  // A 0.17.31-era install carries no bundle manifest and names its source commit (the shape the smoke's
  // own synthetic tree modeled).
  fs.rmSync(manifestPath)
  fs.writeFileSync(path.join(tree, '.hermes-source-commit'), `${F8}\n`)
}

// Fail here, with the cause, rather than as a version mismatch deep inside the smoke.
function assertGenuineF8(tree) {
  const python = path.join(tree, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const probe = spawnSync(python, ['-I', '-c', 'import json,sys,yaml; print(json.dumps(sys.version_info[:2]))'], { encoding: 'utf8' })

  if (probe.status !== 0) {
    throw new Error(`F8 legacy tree cannot run its own interpreter with PyYAML: ${probe.stderr || probe.error}`)
  }

  const series = JSON.parse(probe.stdout.trim())

  if (series[0] !== F8_PYTHON_SERIES[0] || series[1] !== F8_PYTHON_SERIES[1]) {
    throw new Error(`F8 legacy tree runs Python ${series.join('.')}, expected ${F8_PYTHON_SERIES.join('.')}`)
  }
}

export function prepareLegacyRuntimeFixture(work) {
  const out = path.join(work, 'out')
  const archive = path.join(out, f8ArchiveName())

  if (!fs.existsSync(archive)) {
    buildF8Archive(work, out)
  }

  const tree = path.join(work, 'tree')
  installTree(archive, tree)
  assertGenuineF8(tree)

  return tree
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--work')

  if (index < 0 || !process.argv[index + 1]) {
    console.error('usage: node scripts/legacy-runtime-fixture.mjs --work DIR')
    process.exit(2)
  }

  console.log(prepareLegacyRuntimeFixture(path.resolve(process.argv[index + 1])))
}
