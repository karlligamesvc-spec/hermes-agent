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

// ---------------------------------------------------------------------------
// hc-634: both network probes must survive a transient blip.
//
// This file had two probes and hardened one of them. fetchLatest() carried an
// inline 3-attempt retry with a comment about not letting a network blip block
// a release; the tarball HEAD called requestStatus() bare. On 2026-07-31 the
// bare one failed the whole 0.17.5 release with "no response" while the object
// was demonstrably fine (HEAD 200, 74.7MB, unchanged since the day before) --
// a US-hosted GitHub runner blipping toward COS ap-guangzhou, i.e. the LONGER
// of the two paths was the unprotected one.
//
// withRetry is the single implementation both now share.
// ---------------------------------------------------------------------------

const { withRetry } = require('./assert-release-preflight.cjs')

test('withRetry: a blip followed by success resolves, and does not block a release', async () => {
  let calls = 0
  const result = await withRetry(async () => {
    calls += 1
    return calls < 3 ? null : 200
  })
  assert.equal(result, 200)
  assert.equal(calls, 3, 'should keep trying up to the 3rd attempt')
})

test('withRetry: a sustained outage still fails closed', async () => {
  let calls = 0
  const result = await withRetry(async () => {
    calls += 1
    return null
  })
  assert.equal(result, null, 'a real outage must not be retried into a false pass')
  assert.equal(calls, 3)
})

test('withRetry: a real answer is returned immediately and never retried', async () => {
  // A 404 is an ANSWER -- a genuinely missing tarball must fail on attempt 1,
  // not be re-probed as though the network were at fault.
  let calls = 0
  const result = await withRetry(async () => {
    calls += 1
    return 404
  })
  assert.equal(result, 404)
  assert.equal(calls, 1, 'an HTTP status is a definitive answer, not a blip')
})

test('withRetry: zero is a real answer, not a falsy miss', async () => {
  let calls = 0
  const result = await withRetry(async () => {
    calls += 1
    return 0
  })
  assert.equal(result, 0)
  assert.equal(calls, 1)
})

test('every network probe is wired through withRetry — the I/O layer unit tests cannot reach', () => {
  // withRetry being correct does not mean the probes USE it. That gap is what
  // shipped the bug: the helper existed (inline in fetchLatest) and the tarball
  // HEAD simply did not go through it. The I/O layer is "only exercised by the
  // CLI path, never by the unit test" (see this module's header), so a behavior
  // test structurally cannot catch the miswiring — assert on the source.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, 'assert-release-preflight.cjs'), 'utf8')

  // Strip comments: the ones explaining this fix necessarily name the call being
  // constrained, and matching those would fail on the documentation itself.
  const code = src
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  // Split into top-level function bodies, then ask which of them reach the wire.
  const bodies = new Map()
  const re = /^(?:async )?function (\w+)/gm
  const marks = [...code.matchAll(re)]
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : code.length
    bodies.set(m[1], code.slice(m.index, end))
  })

  const callers = [...bodies].filter(([name, body]) => name !== 'requestStatus' && /requestStatus\(/.test(body)).map(([name]) => name)
  assert.deepEqual(
    callers.sort(),
    ['fetchLatest', 'headStatus'],
    'only the two retrying probes may touch requestStatus; a new bare caller is the exact bug this guards'
  )
  for (const name of callers) {
    assert.match(bodies.get(name), /withRetry\(/, `${name} must route its probe through withRetry`)
  }
})
