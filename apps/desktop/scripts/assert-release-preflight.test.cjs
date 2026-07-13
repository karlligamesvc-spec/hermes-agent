'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { evaluatePreflight } = require('./assert-release-preflight.cjs')

// Helper: pull one gate's check out of the result by name.
function gate(result, name) {
  const c = result.checks.find(x => x.gate === name)
  assert.ok(c, `expected a '${name}' check to be present`)
  return c
}

// A well-formed /latest body factory — override per case.
function latestBody(over = {}) {
  return {
    version: 'v2026.7.13-fork.3ab3eabf',
    cos_tarball_url: 'https://cos.example.com/runtime/hermes-agent-abc.tar.gz',
    min_desktop_version: null,
    ...over
  }
}

// ---------------------------------------------------------------------------
// The two real-world anchors the PR body cites: gate 2 must hold in the intended
// post-flip end-state, and must (correctly) BLOCK in today's transitional state.
// ---------------------------------------------------------------------------

test('post-flip end-state (default engine == shell requirement) — all gates pass', () => {
  const r = evaluatePreflight({
    latest: latestBody({ version: 'v2026.7.13-fork.3ab3eabf', min_desktop_version: '0.16.11' }),
    minEngineVersion: 'v2026.7.13-fork.3ab3eabf',
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(r.ok, true)
  assert.equal(gate(r, 'latest-reachable').ok, true)
  assert.equal(gate(r, 'tarball-head').ok, true)
  assert.equal(gate(r, 'engine-floor').ok, true)
  assert.equal(gate(r, 'desktop-floor').ok, true)
})

test('current live prod (default engine v2026.7.12 behind a v2026.7.13 shell floor) — engine-floor BLOCKS', () => {
  // Verified live: /latest.version=v2026.7.12-fork.6f855229, min_desktop_version=null.
  const r = evaluatePreflight({
    latest: latestBody({ version: 'v2026.7.12-fork.6f855229', min_desktop_version: null }),
    minEngineVersion: 'v2026.7.13-fork.3ab3eabf',
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(r.ok, false)
  assert.equal(gate(r, 'tarball-head').ok, true) // tarball itself is fine
  assert.equal(gate(r, 'desktop-floor').skipped, true) // min_desktop_version null -> skipped
  const ef = gate(r, 'engine-floor')
  assert.equal(ef.ok, false)
  assert.match(ef.message, /BEHIND the shell-required minEngineVersion/)
})

// ---------------------------------------------------------------------------
// Fail-CLOSED contract (the release gate's opposite duty vs the runtime gate).
// ---------------------------------------------------------------------------

test('unreachable /latest fails closed (cannot certify the contract)', () => {
  const r = evaluatePreflight({ latest: null, minEngineVersion: 'v2026.7.13', shellVersion: '0.16.11', tarballStatus: null })
  assert.equal(r.ok, false)
  assert.equal(gate(r, 'latest-reachable').ok, false)
  // No downstream checks are fabricated when /latest is unusable.
  assert.equal(r.checks.length, 1)
})

test('unparseable latest.version against a declared floor fails closed (no silent pass)', () => {
  const r = evaluatePreflight({
    latest: latestBody({ version: 'garbage' }),
    minEngineVersion: 'v2026.7.13-fork.3ab3eabf',
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'engine-floor').ok, false)
  assert.match(gate(r, 'engine-floor').message, /cannot compare/)
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------------------
// Gate 2a — tarball reachability.
// ---------------------------------------------------------------------------

test('tarball HEAD non-200 blocks', () => {
  const r = evaluatePreflight({ latest: latestBody(), minEngineVersion: null, shellVersion: '0.16.11', tarballStatus: 404 })
  assert.equal(gate(r, 'tarball-head').ok, false)
  assert.match(gate(r, 'tarball-head').message, /404/)
  assert.equal(r.ok, false)
})

test('missing cos_tarball_url blocks', () => {
  const r = evaluatePreflight({
    latest: latestBody({ cos_tarball_url: null }),
    minEngineVersion: null,
    shellVersion: '0.16.11',
    tarballStatus: null
  })
  assert.equal(gate(r, 'tarball-head').ok, false)
  assert.match(gate(r, 'tarball-head').message, /no cos_tarball_url/)
})

// ---------------------------------------------------------------------------
// Gate 2b — engine floor (skip when undeclared; boundary is inclusive).
// ---------------------------------------------------------------------------

test('no declared minEngineVersion skips the engine-floor gate', () => {
  const r = evaluatePreflight({ latest: latestBody(), minEngineVersion: null, shellVersion: '0.16.11', tarballStatus: 200 })
  const ef = gate(r, 'engine-floor')
  assert.equal(ef.ok, true)
  assert.equal(ef.skipped, true)
})

test('engine-floor is inclusive (latest == floor passes) and ignores the -fork.<sha> suffix', () => {
  const r = evaluatePreflight({
    // Same calver triple, DIFFERENT fork sha — must still compare equal.
    latest: latestBody({ version: 'v2026.7.13-fork.deadbeef' }),
    minEngineVersion: 'v2026.7.13-fork.3ab3eabf',
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'engine-floor').ok, true)
})

test('engine-floor passes when the default engine is AHEAD of the floor', () => {
  const r = evaluatePreflight({
    latest: latestBody({ version: 'v2026.8.1-fork.0000' }),
    minEngineVersion: 'v2026.7.13-fork.3ab3eabf',
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'engine-floor').ok, true)
})

// ---------------------------------------------------------------------------
// Gate 2c — desktop floor (skip when engine declares none; boundary inclusive).
// ---------------------------------------------------------------------------

test('desktop-floor blocks when the engine requires a newer shell than we are cutting', () => {
  const r = evaluatePreflight({
    latest: latestBody({ min_desktop_version: '0.17.0' }),
    minEngineVersion: null,
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'desktop-floor').ok, false)
  assert.match(gate(r, 'desktop-floor').message, /requires desktop >= 0\.17\.0/)
  assert.equal(r.ok, false)
})

test('desktop-floor is inclusive (min_desktop_version == shell passes)', () => {
  const r = evaluatePreflight({
    latest: latestBody({ min_desktop_version: '0.16.11' }),
    minEngineVersion: null,
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'desktop-floor').ok, true)
})

test('desktop-floor skipped when /latest declares no min_desktop_version', () => {
  const r = evaluatePreflight({
    latest: latestBody({ min_desktop_version: null }),
    minEngineVersion: null,
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'desktop-floor').skipped, true)
})

test('unparseable min_desktop_version fails closed', () => {
  const r = evaluatePreflight({
    latest: latestBody({ min_desktop_version: 'not-a-version-x' }),
    minEngineVersion: null,
    shellVersion: '0.16.11',
    tarballStatus: 200
  })
  assert.equal(gate(r, 'desktop-floor').ok, false)
  assert.match(gate(r, 'desktop-floor').message, /cannot compare/)
})
