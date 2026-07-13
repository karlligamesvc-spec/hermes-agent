'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const {
  parseCosTarballKey,
  derivePinFromLatest,
  parseSemver,
  compareSemver,
  desktopMeetsMinVersion,
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
// hc-475 (F4): min_desktop_version shell↔runtime compatibility gate
// ---------------------------------------------------------------------------

test('derivePinFromLatest: reads min_desktop_version when present', () => {
  const pin = derivePinFromLatest({ ...publishedBody(SHA, 'v'), min_desktop_version: '0.16.10' })
  assert.ok(pin)
  assert.equal(pin.minDesktopVersion, '0.16.10')
})

test('derivePinFromLatest: min_desktop_version null/absent -> null (no gate)', () => {
  assert.equal(derivePinFromLatest(publishedBody(SHA, 'v')).minDesktopVersion, null)
  assert.equal(derivePinFromLatest({ ...publishedBody(SHA, 'v'), min_desktop_version: null }).minDesktopVersion, null)
  assert.equal(derivePinFromLatest({ ...publishedBody(SHA, 'v'), min_desktop_version: '' }).minDesktopVersion, null)
})

test('parseSemver: tolerant parse (v-prefix, missing parts, prerelease/build)', () => {
  assert.deepEqual(parseSemver('0.16.10'), [0, 16, 10])
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseSemver('2'), [2, 0, 0])
  assert.deepEqual(parseSemver('1.4'), [1, 4, 0])
  assert.deepEqual(parseSemver('0.16.10-beta.1+build'), [0, 16, 10])
  assert.equal(parseSemver('not-a-version'), null)
  assert.equal(parseSemver(''), null)
})

test('compareSemver: ordering + null on unparseable', () => {
  assert.equal(compareSemver('0.16.9', '0.16.10'), -1) // numeric, not lexical
  assert.equal(compareSemver('0.16.10', '0.16.9'), 1)
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemver('v0.17.0', '0.16.99'), 1)
  assert.equal(compareSemver('garbage', '1.0.0'), null)
})

test('desktopMeetsMinVersion: no gate / satisfied / equal -> true', () => {
  assert.equal(desktopMeetsMinVersion('0.16.5', null), true) // no gate
  assert.equal(desktopMeetsMinVersion('0.16.5', ''), true) // no gate
  assert.equal(desktopMeetsMinVersion('0.16.10', '0.16.9'), true) // newer
  assert.equal(desktopMeetsMinVersion('0.16.10', '0.16.10'), true) // equal is OK
})

test('desktopMeetsMinVersion: shell older than required -> false (BLOCK)', () => {
  assert.equal(desktopMeetsMinVersion('0.16.9', '0.16.10'), false)
  assert.equal(desktopMeetsMinVersion('0.15.0', '0.16.0'), false)
})

test('desktopMeetsMinVersion: unparseable version fails OPEN (never brick)', () => {
  assert.equal(desktopMeetsMinVersion(null, '0.16.10'), true)
  assert.equal(desktopMeetsMinVersion('dev', '0.16.10'), true)
  assert.equal(desktopMeetsMinVersion('0.16.9', 'garbage'), true)
})

test('checkForRuntimeUpdate: gated (shell too old) -> updateAvailable false + desktopUpgradeRequired', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: 'aaaaaaa', version: '0.16.9' },
    desktopVersion: '0.16.9',
    fetchJson: async () => ({ ...publishedBody(SHA, 'newer'), min_desktop_version: '0.16.10' })
  })
  assert.equal(res.updateAvailable, false)
  assert.ok(res.desktopUpgradeRequired)
  assert.equal(res.desktopUpgradeRequired.minDesktopVersion, '0.16.10')
  assert.equal(res.desktopUpgradeRequired.currentDesktopVersion, '0.16.9')
  // still surfaces the latest engine info + its gate on the latest ref
  assert.equal(res.latest.minDesktopVersion, '0.16.10')
})

test('checkForRuntimeUpdate: shell satisfies gate -> normal update, no desktopUpgradeRequired', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: 'aaaaaaa', version: '0.16.9' },
    desktopVersion: '0.16.10',
    fetchJson: async () => ({ ...publishedBody(SHA, 'newer'), min_desktop_version: '0.16.10' })
  })
  assert.equal(res.updateAvailable, true)
  assert.equal(res.desktopUpgradeRequired, undefined)
  assert.equal(res.latest.minDesktopVersion, '0.16.10')
})

test('checkForRuntimeUpdate: no min_desktop_version -> gate is a no-op', async () => {
  const res = await checkForRuntimeUpdate({
    apiBase: 'https://api.apex-nodes.com',
    marker: { pinnedCommit: 'aaaaaaa' },
    desktopVersion: '0.1.0',
    fetchJson: async () => publishedBody(SHA, 'newer')
  })
  assert.equal(res.updateAvailable, true)
  assert.equal(res.desktopUpgradeRequired, undefined)
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

// ---------------------------------------------------------------------------
// main.cjs glue source-contract (electron-bound; can't be required directly).
// These guard the brick-safety wiring against a future refactor silently
// dropping it. Same source-assertion pattern as windows-child-process.test.cjs.
// ---------------------------------------------------------------------------

function mainSource() {
  return fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
}

test('main.cjs: a pending pin override forces the bootstrap re-run (steps 4-5 gated)', () => {
  const src = mainSource()
  assert.match(src, /const runtimeUpdatePending = readRuntimePinOverride\(\) !== null/)
  // Step 4 (existing `hermes` on PATH) must be skipped while an update is pending.
  assert.match(src, /if \(!runtimeUpdatePending && process\.env\.HERMES_DESKTOP_IGNORE_EXISTING !== '1'\)/)
  // Step 5 (system python) must be skipped too.
  assert.match(src, /const python = runtimeUpdatePending \? null : findSystemPython\(\)/)
})

test('main.cjs: failed AND cancelled bootstrap roll the opt-in update back', () => {
  const src = mainSource()
  // Both terminal paths must restore the previous marker.
  assert.match(src, /rollbackRuntimePinOverride\('install cancelled'\)/)
  assert.match(src, /rollbackRuntimePinOverride\(bootstrapResult\.failedStage \|\| 'bootstrap failed'\)/)
})

test('main.cjs: apply-update verifies artifact reachability BEFORE retargeting', () => {
  const src = mainSource()
  // The HEAD pre-flight must appear, and the override must only be written after.
  const reachIdx = src.indexOf('isUpdateArtifactReachable(pin.cosTarballUrl)')
  const writeIdx = src.indexOf('writeRuntimePinOverride({')
  assert.notEqual(reachIdx, -1, 'reachability probe missing')
  assert.notEqual(writeIdx, -1, 'override write missing')
  assert.ok(reachIdx < writeIdx, 'artifact must be probed before the override is persisted')
})

test('main.cjs: a successful re-bootstrap retires the pin override', () => {
  const src = mainSource()
  assert.match(src, /clearRuntimePinOverride\(\)/)
  // The override is persisted under HERMES_HOME (survives a checkout wipe), not
  // inside ACTIVE_HERMES_ROOT.
  assert.match(src, /RUNTIME_PIN_OVERRIDE_PATH = path\.join\(HERMES_HOME, '\.apexnodes-runtime-override\.json'\)/)
})

test('main.cjs: R5 IPC channels + the runtime preload bridge are registered', () => {
  const src = mainSource()
  assert.match(src, /ipcMain\.handle\('hermes:runtime:check-update'/)
  assert.match(src, /ipcMain\.handle\('hermes:runtime:apply-update'/)
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8')
  assert.match(preload, /checkUpdate: \(\) => ipcRenderer\.invoke\('hermes:runtime:check-update'\)/)
  assert.match(preload, /applyUpdate: \(\) => ipcRenderer\.invoke\('hermes:runtime:apply-update'\)/)
})
