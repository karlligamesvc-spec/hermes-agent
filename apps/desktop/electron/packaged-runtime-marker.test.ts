// hc-1033: a machine whose engine version marker went missing never upgraded its engine again.
// Fixture commits are the real ones from the reported Mac: it ran d4a31394 (2026-10-06) under every
// app version through 0.17.61, whose shipped engine is a2e1a4b5.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain } from 'electron'
import { afterEach, test } from 'vitest'

import {
  bundledEnginePin,
  packagedEngineKeptBack,
  packagedRuntimeDecision,
  type PackagedRuntimeRelease,
  type PackagedRuntimeResult,
  readPackagedRuntime
} from './packaged-runtime'
import { releaseSupersedes, repairEngineMarker, supersededByRelease } from './packaged-runtime-marker'
import { registerRuntimeVersionIpc } from './runtime-version'

const KEPT = 'd4a31394f437a669ba0ff9ef6902ef22cecacbeb'
const SKIPPED = '123f411d9dec389db44e297e62438dea525c28af'
const SHIPPED = 'a2e1a4b574225c0a29087a2102c54c62c97b629a'
const NEWER = 'e'.repeat(40)

const release: PackagedRuntimeRelease = {
  schemaVersion: 1,
  runtime_commit: SHIPPED,
  runtime_version: 'v2026.10.23-fork.a2e1a4b5',
  min_desktop_version: '0.17.61',
  uv_version: '0.12.3',
  supersedes: { [KEPT]: 'v2026.10.6-fork.d4a31394', [SKIPPED]: 'v2026.10.9-fork.123f411d' }
}

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {fs.rmSync(home, { recursive: true, force: true })}
})

function home() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hc1033-'))
  homes.push(directory)

  return directory
}

/** An installed engine at HERMES_HOME/hermes-agent: source stamp, optional bundle manifest and marker. */
function engine(hermesHome: string, { stamp, manifestCommit, marker }: { stamp: string; manifestCommit?: string | null; marker?: object }) {
  const root = path.join(hermesHome, 'hermes-agent')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '.hermes-source-commit'), `${stamp}\n`)

  if (manifestCommit) {
    fs.writeFileSync(path.join(root, '.bundle-manifest.json'), JSON.stringify({ key: manifestCommit.slice(0, 12), runtime_commit: manifestCommit }))
  }

  if (marker) {fs.writeFileSync(path.join(root, '.hermes-bootstrap-complete'), JSON.stringify({ schemaVersion: 1, ...marker }))}

  return root
}

const withoutList = (({ supersedes: _, ...rest }) => rest)(release) as PackagedRuntimeRelease

test.each([
  ['the reported Mac: a listed bundle with no marker', { stamp: KEPT, manifestCommit: KEPT }, release, 'install'],
  ['before hc-1033 the same machine was kept forever', { stamp: KEPT, manifestCommit: KEPT }, withoutList, 'preserve'],
  ['a stale marker naming another engine does not hide a listed one', { stamp: KEPT, manifestCommit: KEPT, marker: { pinnedCommit: SKIPPED, version: 'v2026.10.9-fork.123f411d' } }, release, 'install'],
  ['a listed source install has only its stamp', { stamp: KEPT, manifestCommit: null }, release, 'install'],
  ['a bundle whose manifest names another commit proves nothing', { stamp: KEPT, manifestCommit: SKIPPED }, release, 'preserve'],
  ['an unlisted engine without a marker is kept (it may be one the user chose)', { stamp: NEWER, manifestCommit: NEWER }, release, 'preserve'],
  ['a marker proving the engine newer still keeps it', { stamp: NEWER, manifestCommit: NEWER, marker: { pinnedCommit: NEWER, version: 'v2026.10.30-fork.eeeeeeee' } }, release, 'preserve'],
  ['a same-day marker still cannot prove order', { stamp: NEWER, manifestCommit: NEWER, marker: { pinnedCommit: NEWER, version: 'v2026.10.23-fork.eeeeeeee' } }, release, 'preserve'],
  ['a marker proving the engine older still upgrades it', { stamp: NEWER, manifestCommit: NEWER, marker: { pinnedCommit: NEWER, version: 'v2026.10.1-fork.eeeeeeee' } }, release, 'install']
] as const)('decision: %s', (_name, installed, shipped, expected) => {
  const root = engine(home(), installed)

  assert.equal(packagedRuntimeDecision(root, shipped, true), expected)
})

test('releaseSupersedes accepts the shipped form and rejects every malformed row', () => {
  assert.deepEqual([...releaseSupersedes(release).keys()], [KEPT, SKIPPED])
  assert.equal(releaseSupersedes(withoutList).size, 0)

  for (const supersedes of [
    [KEPT],
    { [KEPT]: 'v2026.10.9-fork.123f411d' },
    { [SHIPPED]: release.runtime_version },
    { [KEPT.slice(0, 12)]: 'v2026.10.6-fork.d4a31394' },
    { [KEPT]: 'd4a31394' },
    { [KEPT]: 7 }
  ]) {
    assert.throws(() => releaseSupersedes({ ...release, supersedes }), /older engine/)
  }
})

test('supersededByRelease needs a listed stamp and, for a bundle, a manifest that agrees', () => {
  const directory = home()

  assert.equal(supersededByRelease(engine(directory, { stamp: KEPT, manifestCommit: KEPT }), KEPT, release), true)
  assert.equal(supersededByRelease(path.join(directory, 'hermes-agent'), null, release), false)
  assert.equal(supersededByRelease(path.join(directory, 'hermes-agent'), NEWER, release), false)
  fs.writeFileSync(path.join(directory, 'hermes-agent', '.bundle-manifest.json'), '{not json')
  assert.equal(supersededByRelease(path.join(directory, 'hermes-agent'), KEPT, release), false)
})

function resources(supersedes: unknown) {
  const directory = path.join(home(), 'bundled-runtime')
  const key = SHIPPED.slice(0, 12)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ ...withoutList, ...(supersedes === undefined ? {} : { supersedes }) }))
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    schema: 1, kind: 'apexnodes-runtime-bundle', framework: 'hermes-agent', key, runtime_commit: SHIPPED, os: 'mac', arch: 'arm64',
    min_desktop_version: release.min_desktop_version,
    archive: { name: `runtime-bundle-${key}-mac-arm64.tar.gz`, size: 1, sha256: 'a'.repeat(64) },
    components: { python: { path: '.runtime/py/cpython-3.14.7' }, venv: { path: 'venv', relocatable: true, uv_version: release.uv_version }, node: { path: '.runtime/node' } },
    fixup: { script: 'scripts/build-runtime-bundle.mjs' },
    files_index: { path: '.runtime/files.tsv', sha256: 'b'.repeat(64) }
  }))

  return path.dirname(directory)
}

test('an installer whose older-engine list is malformed does not load; a good one yields the shipped pin', () => {
  assert.throws(() => readPackagedRuntime(resources({ [KEPT]: 'v2026.10.9-fork.123f411d' }), 'darwin', 'arm64'), /older engine/)
  assert.deepEqual(readPackagedRuntime(resources(release.supersedes), 'darwin', 'arm64').release.supersedes, release.supersedes)
  assert.deepEqual(bundledEnginePin(resources(undefined), 'darwin', 'arm64'), {
    commit: SHIPPED, key: SHIPPED, branch: null, version: release.runtime_version, minDesktopVersion: release.min_desktop_version
  })
})

test('kept-back reports a preserved, failed or busy upgrade, never the shipped engine or a provably newer one', async () => {
  const directory = home()
  const report = (result: PackagedRuntimeResult | null) => packagedEngineKeptBack(Promise.resolve(result), () => release, directory)

  engine(directory, { stamp: NEWER, manifestCommit: NEWER })
  assert.deepEqual(await report({ status: 'preserved', reason: 'newer-or-unknown', runtimeCommit: NEWER }), { reason: 'newer-or-unknown', bundledVersion: release.runtime_version })
  assert.deepEqual(await report({ status: 'preserved', reason: 'upgrade-failed', runtimeCommit: KEPT }), { reason: 'upgrade-failed', bundledVersion: release.runtime_version })
  // hc-1117: a boot install that waits on a process holding the engine retries by itself, but nothing else would say so.
  assert.deepEqual(await report({ status: 'preserved', reason: 'busy', runtimeCommit: KEPT }), { reason: 'busy', bundledVersion: release.runtime_version })
  assert.equal(await report({ status: 'installed', runtimeCommit: SHIPPED }), null)
  assert.equal(await report({ status: 'current', runtimeCommit: SHIPPED }), null)
  assert.equal(await report(null), null)
  assert.equal(await packagedEngineKeptBack(Promise.reject(new Error('install failed')), () => release, directory), null)

  // A shell downgrade: the kept engine's marker names it and is newer, so keeping it is right.
  fs.writeFileSync(path.join(directory, 'hermes-agent', '.hermes-bootstrap-complete'), JSON.stringify({ pinnedCommit: NEWER, version: 'v2026.10.30-fork.eeeeeeee' }))
  assert.equal(await report({ status: 'preserved', reason: 'newer-or-unknown', runtimeCommit: NEWER }), null)
  assert.deepEqual(await report({ status: 'preserved', reason: 'upgrade-failed', runtimeCommit: NEWER }), { reason: 'upgrade-failed', bundledVersion: release.runtime_version })
})

test.each([
  ['a build that ships its engine keeps the marker', true, true],
  ['a build without one still drops it for the source installer', false, false]
])('repair: %s', (_name, ships, kept) => {
  const root = engine(home(), { stamp: KEPT, manifestCommit: KEPT, marker: { pinnedCommit: KEPT, version: 'v2026.10.6-fork.d4a31394' } })
  const marker = path.join(root, '.hermes-bootstrap-complete')
  const lines: string[] = []

  repairEngineMarker({ markerPath: marker, keepMarker: ships, log: line => lines.push(line) })

  assert.equal(fs.existsSync(marker), kept)
  assert.match(lines.join('\n'), kept ? /keeping the engine version marker/ : /clearing marker/)
  // An already-missing marker is not an error.
  repairEngineMarker({ markerPath: marker, keepMarker: ships, log: line => lines.push(line) })
  assert.equal(lines.some(line => line.includes('failed to remove')), false)
})

function ipc(dependencies: Partial<Parameters<typeof registerRuntimeVersionIpc>[1]>) {
  const handlers = new Map<string, () => Promise<any>>()
  const ipcMain = { handle: (channel: string, listener: () => Promise<any>) => handlers.set(channel, listener) } as unknown as Pick<IpcMain, 'handle'>

  registerRuntimeVersionIpc(ipcMain, {
    waitForRuntimePreparation: async () => {},
    readMarker: () => null,
    readTreeCommit: () => KEPT,
    minEngineVersion: () => null,
    log: () => {},
    ...dependencies
  })

  return { version: handlers.get('hermes:runtime:version')!, switchEngine: handlers.get('hermes:runtime:switch-to-bundled-engine')! }
}

test('the version read carries the kept-back report; the switch applies only the shipped pin', async () => {
  const keptBack = { reason: 'newer-or-unknown', bundledVersion: release.runtime_version }
  const applied: unknown[] = []
  const pin = { key: SHIPPED, version: release.runtime_version }

  const apply = (answer: object) => async (value: unknown) => {
    applied.push(value)

    return answer
  }

  const live = ipc({ keptBack: async () => keptBack, bundledEnginePin: () => pin, applyPin: apply({ ok: true, applied: true, reloadRequired: true }) })
  assert.deepEqual((await live.version()).keptBack, keptBack)
  assert.deepEqual(await live.switchEngine(), { ok: true, applied: true, reloadRequired: true })
  assert.deepEqual(applied, [pin])

  // A development or diagnostic build gets no pin and must never reach the apply (its source-installer path).
  const refused = ipc({ bundledEnginePin: () => null, applyPin: apply({ ok: true }) })
  assert.equal((await refused.version()).keptBack, null)
  assert.deepEqual(await refused.switchEngine(), { ok: false, error: 'unsupported' })
  assert.deepEqual(applied, [pin])

  const failing = ipc({ bundledEnginePin: () => pin, applyPin: async () => { throw new Error('preflight exploded') } })
  assert.deepEqual(await failing.switchEngine(), { ok: false, error: 'preflight exploded' })
})
