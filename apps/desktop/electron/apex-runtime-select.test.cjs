'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  canUseOnDiskRuntime,
  resolvePreBootstrapDecision,
  resolveBootstrapFailureFallback
} = require('./apex-runtime-select.cjs')

// ---------------------------------------------------------------------------
// canUseOnDiskRuntime
// ---------------------------------------------------------------------------

test('canUseOnDiskRuntime: source + python present -> usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: true, pythonPresent: true }), true)
})

test('canUseOnDiskRuntime: missing python -> not usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: true, pythonPresent: false }), false)
})

test('canUseOnDiskRuntime: missing source -> not usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: false, pythonPresent: true }), false)
})

test('canUseOnDiskRuntime: nothing present -> not usable', () => {
  assert.equal(canUseOnDiskRuntime({ sourcePresent: false, pythonPresent: false }), false)
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
