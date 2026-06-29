'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  parseCosTarballKey,
  derivePinFromLatest,
  latestUrl,
  resolveLatestRuntimePin,
  checkForRuntimeUpdate,
  overlayStampWithPin
} = require('./apex-runtime-latest.cjs')

const SHA = '87740e8021390455962caa3ad2c16d522c0d306a'
const COS_BASE = 'https://bucket.cos.ap-guangzhou.myqcloud.com/runtime'

// ---------------------------------------------------------------------------
// parseCosTarballKey
// ---------------------------------------------------------------------------

test('parseCosTarballKey extracts a SHA key from a published URL', () => {
  assert.equal(parseCosTarballKey(`${COS_BASE}/hermes-agent-${SHA}.tar.gz`), SHA)
})

test('parseCosTarballKey extracts a tag key', () => {
  assert.equal(parseCosTarballKey(`${COS_BASE}/hermes-agent-v2026.6.25.tar.gz`), 'v2026.6.25')
})

test('parseCosTarballKey strips query/fragment', () => {
  assert.equal(parseCosTarballKey(`${COS_BASE}/hermes-agent-${SHA}.tar.gz?x=1#y`), SHA)
})

test('parseCosTarballKey returns empty for non-matching or empty input', () => {
  assert.equal(parseCosTarballKey(''), '')
  assert.equal(parseCosTarballKey(null), '')
  assert.equal(parseCosTarballKey(`${COS_BASE}/something-else.tar.gz`), '')
})

// ---------------------------------------------------------------------------
// derivePinFromLatest
// ---------------------------------------------------------------------------

test('derivePinFromLatest: published SHA URL -> commit pin (COS key = SHA)', () => {
  const pin = derivePinFromLatest({
    version: '0.17.0-moa',
    upstream_release_tag: 'v2026.6.19',
    cos_tarball_url: `${COS_BASE}/hermes-agent-${SHA}.tar.gz`,
    cos_publish_status: 'published'
  })
  assert.ok(pin)
  assert.equal(pin.key, SHA)
  assert.equal(pin.commit, SHA) // install.sh keys COS by --commit
  assert.equal(pin.branch, 'v2026.6.19') // tag kept for non-CN git clone
  assert.equal(pin.version, '0.17.0-moa')
})

test('derivePinFromLatest: published tag-keyed URL -> branch pin (no SHA)', () => {
  const pin = derivePinFromLatest({
    version: '2026.6.25',
    upstream_release_tag: 'v2026.6.25',
    cos_tarball_url: `${COS_BASE}/hermes-agent-v2026.6.25.tar.gz`,
    cos_publish_status: 'published'
  })
  assert.ok(pin)
  assert.equal(pin.key, 'v2026.6.25')
  assert.equal(pin.commit, null) // tag, not a SHA
  assert.equal(pin.branch, 'v2026.6.25')
})

test('derivePinFromLatest: unpublished COS status falls back to structured key, not the URL', () => {
  // cos_tarball_url present but NOT published -> must not key off it (would 404).
  // Falls back to upstream_commit.
  const pin = derivePinFromLatest({
    version: 'x',
    upstream_commit: SHA,
    cos_tarball_url: `${COS_BASE}/hermes-agent-deadbeef.tar.gz`,
    cos_publish_status: 'pending'
  })
  assert.ok(pin)
  assert.equal(pin.key, SHA)
  assert.equal(pin.commit, SHA)
})

test('derivePinFromLatest: no URL, only upstream_commit -> commit pin', () => {
  const pin = derivePinFromLatest({ version: 'x', upstream_commit: SHA })
  assert.ok(pin)
  assert.equal(pin.key, SHA)
  assert.equal(pin.commit, SHA)
})

test('derivePinFromLatest: no URL, only release tag -> branch pin', () => {
  const pin = derivePinFromLatest({ version: 'x', upstream_release_tag: 'v9.9.9' })
  assert.ok(pin)
  assert.equal(pin.key, 'v9.9.9')
  assert.equal(pin.commit, null)
  assert.equal(pin.branch, 'v9.9.9')
})

test('derivePinFromLatest: only version label -> version as key', () => {
  const pin = derivePinFromLatest({ version: 'release-42' })
  assert.ok(pin)
  assert.equal(pin.key, 'release-42')
})

test('derivePinFromLatest: empty / no key fields -> null', () => {
  assert.equal(derivePinFromLatest(null), null)
  assert.equal(derivePinFromLatest({}), null)
  assert.equal(derivePinFromLatest({ image_tag: 'foo:bar' }), null)
})

test('derivePinFromLatest: case-insensitive publish status', () => {
  const pin = derivePinFromLatest({
    version: 'x',
    cos_tarball_url: `${COS_BASE}/hermes-agent-${SHA}.tar.gz`,
    cos_publish_status: 'PUBLISHED'
  })
  assert.ok(pin)
  assert.equal(pin.key, SHA)
})

// ---------------------------------------------------------------------------
// latestUrl
// ---------------------------------------------------------------------------

test('latestUrl builds the framework-filtered endpoint and trims base slash', () => {
  assert.equal(
    latestUrl('https://api.apex-nodes.com/'),
    'https://api.apex-nodes.com/api/v1/runtime/latest?framework=hermes-agent'
  )
})

// ---------------------------------------------------------------------------
// resolveLatestRuntimePin — fallback safety (iron rule)
// ---------------------------------------------------------------------------

test('resolveLatestRuntimePin returns null when fetch throws (offline) — never throws', async () => {
  const pin = await resolveLatestRuntimePin({
    apiBase: 'https://api.apex-nodes.com',
    fetchJson: async () => {
      throw new Error('ENOTFOUND api.apex-nodes.com')
    }
  })
  assert.equal(pin, null)
})

test('resolveLatestRuntimePin returns null on 404 no-default', async () => {
  const pin = await resolveLatestRuntimePin({
    apiBase: 'https://api.apex-nodes.com',
    fetchJson: async () => {
      throw new Error('404: {"detail":"no_default_runtime_version"}')
    }
  })
  assert.equal(pin, null)
})

test('resolveLatestRuntimePin resolves a real body and passes timeout through', async () => {
  let seenUrl = null
  let seenOpts = null
  const pin = await resolveLatestRuntimePin({
    apiBase: 'https://api.apex-nodes.com',
    timeoutMs: 5000,
    fetchJson: async (url, opts) => {
      seenUrl = url
      seenOpts = opts
      return {
        version: '0.17.0-moa',
        cos_tarball_url: `${COS_BASE}/hermes-agent-${SHA}.tar.gz`,
        cos_publish_status: 'published'
      }
    }
  })
  assert.ok(pin)
  assert.equal(pin.commit, SHA)
  assert.equal(seenUrl, 'https://api.apex-nodes.com/api/v1/runtime/latest?framework=hermes-agent')
  assert.equal(seenOpts.timeoutMs, 5000)
})

test('resolveLatestRuntimePin returns null when apiBase/fetchJson missing', async () => {
  assert.equal(await resolveLatestRuntimePin({ apiBase: '', fetchJson: async () => ({}) }), null)
  assert.equal(await resolveLatestRuntimePin({ apiBase: 'x', fetchJson: null }), null)
})

// ---------------------------------------------------------------------------
// checkForRuntimeUpdate
// ---------------------------------------------------------------------------

function publishedBody(key, version) {
  return {
    version: version || 'v',
    cos_tarball_url: `${COS_BASE}/hermes-agent-${key}.tar.gz`,
    cos_publish_status: 'published'
  }
}

test('checkForRuntimeUpdate: different key -> updateAvailable true', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: 'aaaaaaa', pinnedBranch: 'v1' },
    fetchJson: async () => publishedBody(SHA, 'new')
  })
  assert.equal(res.updateAvailable, true)
  assert.equal(res.current.key, 'aaaaaaa')
  assert.equal(res.latest.key, SHA)
})

test('checkForRuntimeUpdate: same key -> updateAvailable false', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: SHA, pinnedBranch: 'v1' },
    fetchJson: async () => publishedBody(SHA, 'same')
  })
  assert.equal(res.updateAvailable, false)
})

test('checkForRuntimeUpdate: same commit key but bumped version -> updateAvailable true', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: SHA, version: '0.17.0' },
    fetchJson: async () => publishedBody(SHA, '0.18.0')
  })
  assert.equal(res.updateAvailable, true)
})

test('checkForRuntimeUpdate: offline -> updateAvailable false, no throw', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: SHA },
    fetchJson: async () => {
      throw new Error('network down')
    }
  })
  assert.equal(res.updateAvailable, false)
  assert.equal(res.latest, null)
})

test('checkForRuntimeUpdate: missing installed key -> no nag, still exposes latest', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: {},
    fetchJson: async () => publishedBody(SHA, 'v')
  })
  assert.equal(res.updateAvailable, false)
  assert.ok(res.latest)
  assert.equal(res.latest.key, SHA)
})

test('checkForRuntimeUpdate: installed via branch key compares against branch', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedBranch: 'v2026.6.19' },
    fetchJson: async () => publishedBody('v2026.6.25', 'newer')
  })
  assert.equal(res.current.key, 'v2026.6.19')
  assert.equal(res.updateAvailable, true)
})

// ---------------------------------------------------------------------------
// overlayStampWithPin
// ---------------------------------------------------------------------------

const BAKED = Object.freeze({
  schemaVersion: 1,
  commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  branch: 'v2026.6.19',
  builtAt: '2026-06-29T00:00:00Z',
  dirty: false,
  source: 'apexnodes-pin'
})

test('overlayStampWithPin: null pin returns the baked stamp unchanged (iron-rule fallback)', () => {
  assert.equal(overlayStampWithPin(BAKED, null), BAKED)
})

test('overlayStampWithPin: SHA pin overrides commit + tags source', () => {
  const pin = derivePinFromLatest(publishedBody(SHA, 'new'))
  const out = overlayStampWithPin(BAKED, pin, 'api-latest')
  assert.equal(out.commit, SHA)
  assert.equal(out.source, 'api-latest')
  assert.equal(out.schemaVersion, 1) // preserved
  assert.equal(out.builtAt, '2026-06-29T00:00:00Z') // preserved
})

test('overlayStampWithPin: tag-only pin keeps baked commit, sets branch to tag', () => {
  const pin = derivePinFromLatest({ version: 'x', upstream_release_tag: 'v9.9.9' })
  const out = overlayStampWithPin(BAKED, pin)
  assert.equal(out.branch, 'v9.9.9')
  assert.equal(out.commit, BAKED.commit) // fallback to baked commit (git clone --branch lands it)
})

test('overlayStampWithPin: null baked + null pin -> null', () => {
  assert.equal(overlayStampWithPin(null, null), null)
})

test('overlayStampWithPin: null baked + real pin -> pin-derived stamp', () => {
  const pin = derivePinFromLatest(publishedBody(SHA, 'new'))
  const out = overlayStampWithPin(null, pin)
  assert.ok(out)
  assert.equal(out.commit, SHA)
})
