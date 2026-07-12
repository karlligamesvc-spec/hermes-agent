/**
 * Tests for electron/apex-platform-skills.cjs (hc-520 fork leg).
 *
 * Run with: node --test electron/apex-platform-skills.test.cjs
 *
 * The pure helpers behind the platform SKILL pull: URL building, response
 * validation/normalization, name/path SAFETY (skills come off the network), the
 * apply predicate + persisted-state normalizer, the fail-soft authed fetch
 * wrapper (stub fetchJson — no network), and the fs apply/remove exercised
 * against a real temp skills root. The security-critical assertions are the
 * containment ones: a hostile path must never escape the platform-skill
 * category directory.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  applyPlatformSkills,
  fetchPlatformSkills,
  isPlatformSkillsEnabled,
  isSafeRelPath,
  isSafeSkillName,
  normalizeSkill,
  normalizeStoredManifest,
  parsePlatformSkillsResponse,
  PLATFORM_SKILLS_CATEGORY,
  PLATFORM_SKILLS_PATH,
  platformSkillsCategoryDir,
  platformSkillsUrl,
  removePlatformSkills,
  shouldApplyManifest
} = require('./apex-platform-skills.cjs')

function tmpSkillsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skills-'))
}

const DOUYIN = {
  files: [{ content: '---\nname: douyin-video-transcript\n---\nuse social_download', path: 'SKILL.md' }],
  hash: 'h1',
  name: 'douyin-video-transcript',
  version: '1.2.0'
}

// ── URL building ────────────────────────────────────────────────────────────

test('platformSkillsUrl: base only vs known_hash, trims slash + encodes', () => {
  assert.equal(platformSkillsUrl('https://api.apex-nodes.com'), `https://api.apex-nodes.com${PLATFORM_SKILLS_PATH}`)
  assert.equal(platformSkillsUrl('https://api.apex-nodes.com/'), `https://api.apex-nodes.com${PLATFORM_SKILLS_PATH}`)
  assert.equal(
    platformSkillsUrl('https://api.apex-nodes.com', 'abc123'),
    `https://api.apex-nodes.com${PLATFORM_SKILLS_PATH}?known_hash=abc123`
  )
  // empty/whitespace knownHash → no query
  assert.equal(platformSkillsUrl('https://x', '   '), `https://x${PLATFORM_SKILLS_PATH}`)
})

// ── name / path safety (security gate) ──────────────────────────────────────

for (const [name, ok] of [
  ['douyin-video-transcript', true],
  ['amazon_listing.v2', true],
  ['A1', true],
  ['..', false],
  ['.', false],
  ['.hidden', false],
  ['a/b', false],
  ['a\\b', false],
  ['', false],
  ['../evil', false]
]) {
  test(`isSafeSkillName(${JSON.stringify(name)}) === ${ok}`, () => {
    assert.equal(isSafeSkillName(name), ok)
  })
}

for (const [rel, ok] of [
  ['SKILL.md', true],
  ['reference/guide.md', true],
  ['scripts/run.py', true],
  ['../escape.md', false],
  ['a/../b', false],
  ['/abs/path', false],
  ['a//b', false],
  ['a\\b', false],
  ['a/./b', false],
  ['', false]
]) {
  test(`isSafeRelPath(${JSON.stringify(rel)}) === ${ok}`, () => {
    assert.equal(isSafeRelPath(rel), ok)
  })
}

test('isSafeRelPath rejects NUL byte', () => {
  assert.equal(isSafeRelPath('a\0b'), false)
})

// ── normalizeSkill ──────────────────────────────────────────────────────────

test('normalizeSkill: valid entry normalized, defaults version to "0"', () => {
  assert.deepEqual(normalizeSkill(DOUYIN), DOUYIN)
  const noVersion = normalizeSkill({ files: [{ content: 'x', path: 'SKILL.md' }], name: 'demo' })
  assert.equal(noVersion.version, '0')
})

test('normalizeSkill: drops unsafe name, missing SKILL.md, unsafe/non-string files', () => {
  assert.equal(normalizeSkill({ files: [{ content: 'x', path: 'SKILL.md' }], name: '../evil' }), null)
  assert.equal(normalizeSkill({ files: [{ content: 'x', path: 'README.md' }], name: 'demo' }), null)
  // unsafe file path dropped; with no SKILL.md left → whole skill rejected
  assert.equal(normalizeSkill({ files: [{ content: 'x', path: '../escape' }], name: 'demo' }), null)
  // non-string content dropped; SKILL.md still present so skill survives w/o it
  const mixed = normalizeSkill({
    files: [{ content: 'ok', path: 'SKILL.md' }, { content: 123, path: 'bad.md' }],
    name: 'demo'
  })
  assert.deepEqual(mixed.files, [{ content: 'ok', path: 'SKILL.md' }])
})

// ── parsePlatformSkillsResponse ─────────────────────────────────────────────

test('parsePlatformSkillsResponse: full manifest', () => {
  const parsed = parsePlatformSkillsResponse({ manifest_hash: 'm1', skills: [DOUYIN], total: 1 })
  assert.equal(parsed.manifestHash, 'm1')
  assert.equal(parsed.unchanged, false)
  assert.deepEqual(parsed.skills, [DOUYIN])
})

test('parsePlatformSkillsResponse: unchanged fast-path (no skills needed)', () => {
  const parsed = parsePlatformSkillsResponse({ manifest_hash: 'm1', unchanged: true })
  assert.deepEqual(parsed, { manifestHash: 'm1', skills: null, unchanged: true })
})

test('parsePlatformSkillsResponse: garbage/missing hash/bad skills → null', () => {
  assert.equal(parsePlatformSkillsResponse(null), null)
  assert.equal(parsePlatformSkillsResponse([]), null)
  assert.equal(parsePlatformSkillsResponse({ skills: [DOUYIN] }), null) // no manifest_hash
  assert.equal(parsePlatformSkillsResponse({ manifest_hash: 'm1', skills: 'nope' }), null)
})

test('parsePlatformSkillsResponse: drops individual bad skills, keeps good', () => {
  const parsed = parsePlatformSkillsResponse({
    manifest_hash: 'm1',
    skills: [DOUYIN, { files: [], name: '../evil' }, { name: 'demo' }]
  })
  assert.deepEqual(parsed.skills.map(s => s.name), ['douyin-video-transcript'])
})

// ── predicates + persisted state ────────────────────────────────────────────

for (const [fetchedHash, appliedHash, expected] of [
  ['m2', 'm1', true],
  ['m1', 'm1', false],
  ['', 'm1', false],
  ['m1', '', true]
]) {
  test(`shouldApplyManifest(${JSON.stringify(fetchedHash)}, ${JSON.stringify(appliedHash)}) === ${expected}`, () => {
    assert.equal(shouldApplyManifest(fetchedHash, appliedHash), expected)
  })
}

test('normalizeStoredManifest: valid vs garbage', () => {
  assert.deepEqual(normalizeStoredManifest({ count: 3, installedAt: 42, manifestHash: 'm1' }), {
    count: 3,
    installedAt: 42,
    manifestHash: 'm1'
  })
  assert.deepEqual(normalizeStoredManifest(null), { count: 0, installedAt: null, manifestHash: '' })
  assert.deepEqual(normalizeStoredManifest({ manifestHash: '' }), { count: 0, installedAt: null, manifestHash: '' })
})

for (const [value, expected] of [
  [undefined, true],
  ['', true],
  ['1', true],
  ['on', true],
  ['0', false],
  ['false', false],
  ['off', false],
  ['no', false],
  ['FALSE', false]
]) {
  test(`isPlatformSkillsEnabled(APEXNODES_PLATFORM_SKILLS=${JSON.stringify(value)}) === ${expected}`, () => {
    assert.equal(isPlatformSkillsEnabled({ APEXNODES_PLATFORM_SKILLS: value }), expected)
  })
}

// ── fs apply / remove (real temp skills root) ───────────────────────────────

test('applyPlatformSkills: writes under skills/apexnodes/<name>/, agent-visible layout', () => {
  const root = tmpSkillsRoot()
  try {
    const result = applyPlatformSkills({ skills: [DOUYIN], skillsRoot: root })
    assert.deepEqual(result.installed, ['douyin-video-transcript'])
    const skillMd = path.join(root, PLATFORM_SKILLS_CATEGORY, 'douyin-video-transcript', 'SKILL.md')
    assert.ok(fs.existsSync(skillMd), 'SKILL.md written under the apexnodes category')
    assert.match(fs.readFileSync(skillMd, 'utf8'), /social_download/)
    assert.equal(platformSkillsCategoryDir(root), path.join(root, PLATFORM_SKILLS_CATEGORY))
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('applyPlatformSkills: clean replace drops a skill the cloud removed', () => {
  const root = tmpSkillsRoot()
  try {
    applyPlatformSkills({
      skills: [DOUYIN, { files: [{ content: 'x', path: 'SKILL.md' }], name: 'old-skill' }],
      skillsRoot: root
    })
    assert.ok(fs.existsSync(path.join(root, PLATFORM_SKILLS_CATEGORY, 'old-skill', 'SKILL.md')))
    // Re-apply without old-skill → it must be gone (clean replace).
    applyPlatformSkills({ skills: [DOUYIN], skillsRoot: root })
    assert.ok(!fs.existsSync(path.join(root, PLATFORM_SKILLS_CATEGORY, 'old-skill')))
    assert.ok(fs.existsSync(path.join(root, PLATFORM_SKILLS_CATEGORY, 'douyin-video-transcript', 'SKILL.md')))
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('applyPlatformSkills: SECURITY — a traversal path never escapes the category dir', () => {
  const root = tmpSkillsRoot()
  try {
    // Hand-built hostile skill (bypasses normalizeSkill by calling apply directly).
    const evil = {
      files: [
        { content: 'pwned', path: '../../escape.txt' },
        { content: 'also-pwned', path: '/tmp/abs-escape.txt' },
        { content: 'ok', path: 'SKILL.md' }
      ],
      name: 'evil'
    }
    const result = applyPlatformSkills({ skills: [evil], skillsRoot: root })
    // The two hostile paths are skipped + reported; only SKILL.md lands.
    assert.ok(result.skippedUnsafe.length >= 2, result.skippedUnsafe.join(','))
    assert.ok(fs.existsSync(path.join(root, PLATFORM_SKILLS_CATEGORY, 'evil', 'SKILL.md')))
    // Nothing written outside the category dir.
    assert.ok(!fs.existsSync(path.join(root, 'escape.txt')))
    assert.ok(!fs.existsSync(path.join(path.dirname(root), 'escape.txt')))
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('applyPlatformSkills: unsafe skill NAME is skipped', () => {
  const root = tmpSkillsRoot()
  try {
    const result = applyPlatformSkills({
      skills: [{ files: [{ content: 'x', path: 'SKILL.md' }], name: '../evil' }],
      skillsRoot: root
    })
    assert.deepEqual(result.installed, [])
    assert.ok(result.skippedUnsafe.includes('../evil'))
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('removePlatformSkills: idempotent category removal', () => {
  const root = tmpSkillsRoot()
  try {
    applyPlatformSkills({ skills: [DOUYIN], skillsRoot: root })
    assert.equal(removePlatformSkills({ skillsRoot: root }).removed, true)
    assert.ok(!fs.existsSync(path.join(root, PLATFORM_SKILLS_CATEGORY)))
    // second removal is a no-op
    assert.equal(removePlatformSkills({ skillsRoot: root }).removed, false)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

// ── fail-soft authed fetch ──────────────────────────────────────────────────

test('fetchPlatformSkills: success → parsed, forwards bearer + known_hash', async () => {
  const seen = {}
  const fetchJson = async (url, options) => {
    seen.url = url
    seen.options = options
    return { manifest_hash: 'm1', skills: [DOUYIN], total: 1 }
  }
  const parsed = await fetchPlatformSkills({
    apiBase: 'https://api.apex-nodes.com',
    fetchJson,
    knownHash: 'prev',
    token: 'jwt-123'
  })
  assert.equal(parsed.manifestHash, 'm1')
  assert.equal(seen.options.bearer, 'jwt-123')
  assert.match(seen.url, /\?known_hash=prev$/)
})

test('fetchPlatformSkills: fetch throws (e.g. 401) → null, fail-soft', async () => {
  const fetchJson = async () => {
    const err = new Error('401: expired')
    err.statusCode = 401
    throw err
  }
  const out = await fetchPlatformSkills({ apiBase: 'https://x', fetchJson, token: 'jwt' })
  assert.equal(out, null)
})

test('fetchPlatformSkills: missing token/apiBase/fetchJson → null (no call)', async () => {
  let called = false
  const fetchJson = async () => {
    called = true
    return {}
  }
  assert.equal(await fetchPlatformSkills({ apiBase: '', fetchJson, token: 'jwt' }), null)
  assert.equal(await fetchPlatformSkills({ apiBase: 'https://x', fetchJson, token: '' }), null)
  assert.equal(await fetchPlatformSkills({ apiBase: 'https://x', fetchJson: null, token: 'jwt' }), null)
  assert.equal(called, false)
})

test('fetchPlatformSkills: malformed body → null', async () => {
  const fetchJson = async () => ({ nope: true })
  assert.equal(await fetchPlatformSkills({ apiBase: 'https://x', fetchJson, token: 'jwt' }), null)
})
