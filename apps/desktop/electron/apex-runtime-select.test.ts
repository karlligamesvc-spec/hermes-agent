import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  canUseOnDiskRuntime,
  resolveBootstrapFailureFallback,
  resolveExternalRuntimeRungs,
  resolvePreBootstrapDecision
} from './apex-runtime-select'

// ---------------------------------------------------------------------------
// canUseOnDiskRuntime
// ---------------------------------------------------------------------------

test('canUseOnDiskRuntime: source + passing runtime import probe -> usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: true, runtimeImportable: true }), true)
})

test('canUseOnDiskRuntime: python exists but runtime imports fail -> not usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: true, runtimeImportable: false }), false)
})

test('canUseOnDiskRuntime: missing source -> not usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: false, runtimeImportable: true }), false)
})

test('canUseOnDiskRuntime: nothing present -> not usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: false, runtimeImportable: false }), false)
})

test('canUseOnDiskRuntime: bad input is safe (returns false)', () => {
  assert.equal(canUseOnDiskRuntime(null), false)
  assert.equal(canUseOnDiskRuntime(undefined), false)
  assert.equal(canUseOnDiskRuntime('yes'), false)
  assert.equal(canUseOnDiskRuntime({}), false)
})

// ---------------------------------------------------------------------------
// resolvePreBootstrapDecision — the root-cause fix
// ---------------------------------------------------------------------------

test('preBootstrap: usable on disk, no marker, no update -> use-installed (adopt, skip network)', () => {
  // This is the incident: a runnable runtime is extracted on disk but the
  // marker is absent, so without this we would fall to bootstrap-needed, resolve
  // the unpublished admin-latest pin, and brick on the 404. Adopt instead.
  assert.equal(
    resolvePreBootstrapDecision({ markerComplete: false, onDiskUsable: true, updatePending: false }),
    'use-installed'
  )
})

test('preBootstrap: marker complete -> bootstrap (caller fast path owns it)', () => {
  assert.equal(
    resolvePreBootstrapDecision({ markerComplete: true, onDiskUsable: true, updatePending: false }),
    'bootstrap'
  )
})

test('preBootstrap: opt-in update pending -> bootstrap even if a usable runtime is on disk', () => {
  // The user explicitly asked for a new version; adopting the old on-disk
  // runtime would silently no-op their request.
  assert.equal(
    resolvePreBootstrapDecision({ markerComplete: false, onDiskUsable: true, updatePending: true }),
    'bootstrap'
  )
})

test('preBootstrap: nothing usable on disk -> bootstrap (genuine first install)', () => {
  assert.equal(
    resolvePreBootstrapDecision({ markerComplete: false, onDiskUsable: false, updatePending: false }),
    'bootstrap'
  )
})

test('preBootstrap: update pending wins over marker-complete too', () => {
  assert.equal(
    resolvePreBootstrapDecision({ markerComplete: true, onDiskUsable: true, updatePending: true }),
    'bootstrap'
  )
})

// ---------------------------------------------------------------------------
// resolveBootstrapFailureFallback — the safety net
// ---------------------------------------------------------------------------

test('failureFallback: usable on disk, no update -> fallback-to-disk (do not brick)', () => {
  assert.equal(
    resolveBootstrapFailureFallback({ onDiskUsable: true, updatePending: false }),
    'fallback-to-disk'
  )
})

test('failureFallback: nothing usable on disk -> fatal (genuinely cannot start)', () => {
  assert.equal(
    resolveBootstrapFailureFallback({ onDiskUsable: false, updatePending: false }),
    'fatal'
  )
})

test('failureFallback: opt-in update pending -> fatal (caller rolls the override back)', () => {
  // A failed opt-in re-bootstrap must go through rollbackRuntimePinOverride(),
  // which restores the previous marker so the OLD runtime boots next launch —
  // not a silent same-launch adoption here.
  assert.equal(
    resolveBootstrapFailureFallback({ onDiskUsable: true, updatePending: true }),
    'fatal'
  )
})

test('failureFallback: bad input is safe (fatal, never a spurious fallback)', () => {
  assert.equal(resolveBootstrapFailureFallback(), 'fatal')
  assert.equal(resolveBootstrapFailureFallback({}), 'fatal')
})

// ---------------------------------------------------------------------------
// resolveExternalRuntimeRungs — a packaged build keeps to its own engine
// ---------------------------------------------------------------------------

const NONE = { explicitCli: false, pathCli: false, systemPython: false }
const OLD_LADDER = { explicitCli: false, pathCli: true, systemPython: true }
const PACKAGED = { isPackaged: true, bundledEngine: true, explicitCli: false, ignoreExisting: false, updatePending: false }
const DEV = { ...PACKAGED, isPackaged: false, bundledEngine: false }

test.each([
  ['packaged with its engine: no PATH CLI, no system Python', PACKAGED, NONE],
  ['packaged with its engine + HERMES_DESKTOP_HERMES: only that command', { ...PACKAGED, explicitCli: true }, { ...NONE, explicitCli: true }],
  ['packaged with its engine + IGNORE_EXISTING: still nothing', { ...PACKAGED, ignoreExisting: true }, NONE],
  ['packaged without an engine (no bundle for this OS): the old ladder', { ...PACKAGED, bundledEngine: false }, OLD_LADDER],
  ['dev build: the old ladder', DEV, OLD_LADDER],
  ['dev build that happens to see a bundle: still the old ladder', { ...DEV, bundledEngine: true }, OLD_LADDER],
  ['dev build + HERMES_DESKTOP_HERMES: the command replaces the PATH lookup', { ...DEV, explicitCli: true }, { explicitCli: true, pathCli: false, systemPython: true }],
  ['dev build + IGNORE_EXISTING: step 4 off, step 5 as before', { ...DEV, ignoreExisting: true }, { ...OLD_LADDER, pathCli: false }],
  ['dev build + IGNORE_EXISTING + HERMES_DESKTOP_HERMES: step 4 off', { ...DEV, ignoreExisting: true, explicitCli: true }, { ...OLD_LADDER, pathCli: false }],
  ['update pending in a dev build: nothing (R5 re-bootstrap)', { ...DEV, explicitCli: true, updatePending: true }, NONE],
  ['update pending in a packaged build: nothing', { ...PACKAGED, explicitCli: true, updatePending: true }, NONE]
] as const)('externalRungs: %s', (_label, input, expected) => {
  assert.deepEqual(resolveExternalRuntimeRungs(input), expected)
})

test('externalRungs: missing flags read as a dev build without overrides (the old ladder)', () => {
  assert.deepEqual(resolveExternalRuntimeRungs(), OLD_LADDER)
  assert.deepEqual(resolveExternalRuntimeRungs({}), OLD_LADDER)
})
