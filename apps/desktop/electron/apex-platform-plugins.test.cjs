/**
 * Tests for electron/apex-platform-plugins.cjs (hc-564 fork leg).
 *
 * Run with: node --test electron/apex-platform-plugins.test.cjs
 *
 * The P0 contract is FIRST: with `APEXNODES_PLATFORM_PLUGINS` unset (the
 * shipped default) the sync entrypoint performs ZERO network calls and ZERO fs
 * actions — current behavior is byte-for-byte unchanged. Then the pure helpers
 * (default-off switch, pinned URL building, manifest/state normalization, diff
 * planning), the strict tar.gz extractor (network archives → wholesale
 * rejection of anything unsafe), the atomic apply (staging + backup-swap;
 * failure restores the previous install), and the DI'd end-to-end sync with
 * stub transports — sha256 mismatch must never touch disk.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const {
  applyPlatformPlugin,
  extractTarGz,
  isPlatformPluginsEnabled,
  isSafePluginName,
  isSafeRelPath,
  MAX_FILES_PER_PLUGIN,
  normalizePluginEntry,
  normalizeStoredPluginsState,
  parsePlatformPluginsManifest,
  planPluginSync,
  PLATFORM_PLUGINS_PATH,
  platformPluginPackageUrl,
  platformPluginsUrl,
  sha256Hex,
  syncPlatformPlugins
} = require('./apex-platform-plugins.cjs')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-plugins-'))
}

// ── in-test deterministic tar.gz builder (mirrors the cloud packager shape) ──

function tarHeader(name, size, typeflag) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 'utf8')
  block.write('0000644\0', 100, 'latin1')
  block.write('0000000\0', 108, 'latin1')
  block.write('0000000\0', 116, 'latin1')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  block.write('00000000000\0', 136, 'latin1')
  block.write('        ', 148, 'latin1')
  block[156] = typeflag === '\0' ? 0 : typeflag.charCodeAt(0)
  block.write('ustar\0', 257, 'latin1')
  block.write('00', 263, 'latin1')
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += block[i]
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

/** files: [{ path, content, typeflag? }] → tar.gz Buffer */
function makeTarGz(files) {
  const chunks = []
  for (const file of files) {
    const data = Buffer.from(file.content || '', 'utf8')
    chunks.push(tarHeader(file.path, data.length, file.typeflag || '0'))
    if (data.length) {
      chunks.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad) chunks.push(Buffer.alloc(pad))
    }
  }
  chunks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 })
}

const PLUGIN_FILES = [
  { content: 'name: apexnodes-social-tools\nversion: "0.3.0"\n', path: 'plugin.yaml' },
  { content: 'TOOLS = ["social_content"]\n', path: '__init__.py' }
]

function manifestEntryFor(name, packageBuffer, files) {
  return {
    files: files.map(file => file.path),
    name,
    sha256: sha256Hex(packageBuffer),
    size: packageBuffer.length,
    version: '0.3.0'
  }
}

// ═══════════════════════ P0: default OFF = zero action ══════════════════════

test('P0 guard: switch off (default env) → syncPlatformPlugins does zero network calls and zero fs actions', async () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins') // deliberately never created
  const stagingRoot = path.join(root, 'staging')
  const calls = []
  const result = await syncPlatformPlugins({
    apiBase: 'https://api.apex-nodes.com',
    env: {}, // unset — the shipped default
    fetchBuffer: async url => {
      calls.push(url)
      throw new Error('network must not be touched')
    },
    fetchJson: async url => {
      calls.push(url)
      throw new Error('network must not be touched')
    },
    log: msg => calls.push(msg),
    pluginsRoot,
    stagingRoot,
    stored: null,
    token: 'jwt'
  })
  assert.equal(result.status, 'disabled')
  assert.deepEqual(calls, []) // no fetch, and (empty prior state) not even a log line
  assert.equal(fs.existsSync(pluginsRoot), false)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('P0 guard: explicit off values and garbage all stay disabled', async () => {
  for (const value of ['0', 'false', 'off', 'no', '', '  ', 'enable-me', 'TRUE-ish']) {
    const calls = []
    const result = await syncPlatformPlugins({
      apiBase: 'https://x',
      env: { APEXNODES_PLATFORM_PLUGINS: value },
      fetchBuffer: async () => calls.push('buffer'),
      fetchJson: async () => calls.push('json'),
      pluginsRoot: '/nonexistent',
      stagingRoot: '/nonexistent-staging',
      stored: null,
      token: 'jwt'
    })
    assert.equal(result.status, 'disabled', `value=${JSON.stringify(value)}`)
    assert.deepEqual(calls, [])
  }
})

test('switch flipped off after installs: files stay, hint logged, still zero network/fs', async () => {
  const logs = []
  const fetches = []
  const result = await syncPlatformPlugins({
    apiBase: 'https://x',
    env: { APEXNODES_PLATFORM_PLUGINS: 'off' },
    fetchBuffer: async () => fetches.push('buffer'),
    fetchJson: async () => fetches.push('json'),
    log: msg => logs.push(msg),
    pluginsRoot: '/nonexistent',
    stagingRoot: '/nonexistent-staging',
    stored: { installedAt: 1, manifestHash: 'aa'.repeat(32), plugins: { 'apexnodes-social-tools': 'ab'.repeat(32) } },
    token: 'jwt'
  })
  assert.equal(result.status, 'disabled')
  assert.deepEqual(fetches, [])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /left in place/)
})

// ── switch parsing ──────────────────────────────────────────────────────────

for (const [value, expected] of [
  [undefined, false],
  ['', false],
  ['0', false],
  ['false', false],
  ['off', false],
  ['no', false],
  ['maybe', false],
  ['1', true],
  ['true', true],
  ['TRUE', true],
  ['on', true],
  [' yes ', true]
]) {
  test(`isPlatformPluginsEnabled(${JSON.stringify(value)}) === ${expected} (default OFF)`, () => {
    assert.equal(isPlatformPluginsEnabled(value === undefined ? {} : { APEXNODES_PLATFORM_PLUGINS: value }), expected)
  })
}

// ── URL building (domain pinned to master base) ─────────────────────────────

test('platformPluginsUrl: base only vs known_hash, trims slash + encodes', () => {
  assert.equal(platformPluginsUrl('https://api.apex-nodes.com'), `https://api.apex-nodes.com${PLATFORM_PLUGINS_PATH}`)
  assert.equal(platformPluginsUrl('https://api.apex-nodes.com/'), `https://api.apex-nodes.com${PLATFORM_PLUGINS_PATH}`)
  assert.equal(
    platformPluginsUrl('https://api.apex-nodes.com', 'abc/123'),
    `https://api.apex-nodes.com${PLATFORM_PLUGINS_PATH}?known_hash=abc%2F123`
  )
  assert.equal(platformPluginsUrl('https://x', '   '), `https://x${PLATFORM_PLUGINS_PATH}`)
})

test('platformPluginPackageUrl: derived from apiBase + validated name only', () => {
  assert.equal(
    platformPluginPackageUrl('https://api.apex-nodes.com/', 'apexnodes-social-tools'),
    `https://api.apex-nodes.com${PLATFORM_PLUGINS_PATH}/apexnodes-social-tools/package`
  )
  // Unsafe names never build a URL — no way for a manifest to steer the path.
  for (const name of ['../evil', 'a/b', '', '.hidden', 'https://evil.example/x']) {
    assert.equal(platformPluginPackageUrl('https://api.apex-nodes.com', name), null, name)
  }
})

// ── name / path safety ──────────────────────────────────────────────────────

for (const [name, ok] of [
  ['apexnodes-social-tools', true],
  ['A1.v2_x', true],
  ['..', false],
  ['.', false],
  ['.hidden', false],
  ['a/b', false],
  ['a\\b', false],
  ['', false]
]) {
  test(`isSafePluginName(${JSON.stringify(name)}) === ${ok}`, () => {
    assert.equal(isSafePluginName(name), ok)
  })
}

for (const [rel, ok] of [
  ['plugin.yaml', true],
  ['sub/mod.py', true],
  ['/abs', false],
  ['../up', false],
  ['a/../b', false],
  ['a//b', false],
  ['a\\b', false],
  ['nul\0byte', false],
  ['', false]
]) {
  test(`isSafeRelPath(${JSON.stringify(rel)}) === ${ok}`, () => {
    assert.equal(isSafeRelPath(rel), ok)
  })
}

// ── manifest entry / body normalization ─────────────────────────────────────

test('normalizePluginEntry: valid entry passes, hostile/broken entries are dropped', () => {
  const good = {
    files: ['plugin.yaml', '__init__.py'],
    name: 'apexnodes-social-tools',
    sha256: 'AB'.repeat(32),
    size: 1234,
    version: '0.3.0'
  }
  const normalized = normalizePluginEntry(good)
  assert.ok(normalized)
  assert.equal(normalized.sha256, 'ab'.repeat(32)) // lowercased
  assert.deepEqual(normalized.files, ['plugin.yaml', '__init__.py'])

  assert.equal(normalizePluginEntry({ ...good, name: '../evil' }), null)
  assert.equal(normalizePluginEntry({ ...good, sha256: 'zz'.repeat(32) }), null)
  assert.equal(normalizePluginEntry({ ...good, sha256: 'abcd' }), null)
  assert.equal(normalizePluginEntry({ ...good, size: 0 }), null)
  assert.equal(normalizePluginEntry({ ...good, size: 1e12 }), null)
  assert.equal(normalizePluginEntry({ ...good, size: 3.14 }), null)
  assert.equal(normalizePluginEntry({ ...good, files: ['__init__.py'] }), null, 'no plugin.yaml → invalid')
  // Unsafe file paths are dropped (not fatal while plugin.yaml survives).
  const traversal = normalizePluginEntry({ ...good, files: ['plugin.yaml', '../../etc/passwd'] })
  assert.deepEqual(traversal.files, ['plugin.yaml'])
})

test('parsePlatformPluginsManifest: garbage → null; unchanged + full shapes parse', () => {
  for (const garbage of [null, [], 'x', {}, { manifest_hash: '' }, { manifest_hash: 'h' }, { manifest_hash: 'h', plugins: 'nope' }]) {
    assert.equal(parsePlatformPluginsManifest(garbage), null)
  }
  assert.deepEqual(parsePlatformPluginsManifest({ manifest_hash: 'h1', unchanged: true }), {
    manifestHash: 'h1',
    plugins: null,
    unchanged: true
  })
  const full = parsePlatformPluginsManifest({
    extra_field: 'ignored',
    manifest_hash: 'h2',
    plugins: [
      { files: ['plugin.yaml'], name: 'apexnodes-video-tools', sha256: 'ab'.repeat(32), size: 10, version: '0.1.0' },
      { files: ['plugin.yaml'], name: '../evil', sha256: 'ab'.repeat(32), size: 10 } // dropped
    ]
  })
  assert.equal(full.unchanged, false)
  assert.equal(full.manifestHash, 'h2')
  assert.equal(full.plugins.length, 1)
  assert.equal(full.plugins[0].name, 'apexnodes-video-tools')
})

test('normalizeStoredPluginsState: garbage degrades to empty; bad names/hashes dropped', () => {
  const empty = { installedAt: null, manifestHash: '', plugins: {} }
  for (const garbage of [null, 'x', [], {}, { manifestHash: '' }, { manifestHash: 42 }]) {
    assert.deepEqual(normalizeStoredPluginsState(garbage), empty)
  }
  const state = normalizeStoredPluginsState({
    installedAt: 1700000000000,
    manifestHash: 'h1',
    plugins: {
      'apexnodes-social-tools': 'AB'.repeat(32),
      '../evil': 'ab'.repeat(32),
      'bad-hash': 'nope'
    }
  })
  assert.equal(state.manifestHash, 'h1')
  assert.equal(state.installedAt, 1700000000000)
  assert.deepEqual(state.plugins, { 'apexnodes-social-tools': 'ab'.repeat(32) })
})

// ── diff planning ───────────────────────────────────────────────────────────

test('planPluginSync: reinstall on sha change OR missing dir; skip only when both match', () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  fs.mkdirSync(path.join(pluginsRoot, 'present-same'), { recursive: true })
  fs.mkdirSync(path.join(pluginsRoot, 'present-changed'), { recursive: true })

  const sha = 'aa'.repeat(32)
  const changed = 'bb'.repeat(32)
  const plan = planPluginSync({
    plugins: [
      { name: 'present-same', sha256: sha },
      { name: 'present-changed', sha256: changed },
      { name: 'missing-dir', sha256: sha }
    ],
    pluginsRoot,
    storedPlugins: { 'missing-dir': sha, 'present-changed': sha, 'present-same': sha }
  })
  assert.deepEqual(plan.upToDate, ['present-same'])
  assert.deepEqual(plan.toInstall.map(entry => entry.name), ['present-changed', 'missing-dir'])
})

// ── tar.gz extraction (strict) ──────────────────────────────────────────────

test('extractTarGz: round-trips a well-formed archive', () => {
  const files = extractTarGz(makeTarGz(PLUGIN_FILES))
  assert.deepEqual(
    files.map(file => file.path),
    ['plugin.yaml', '__init__.py']
  )
  assert.equal(files[0].data.toString('utf8'), PLUGIN_FILES[0].content)
  assert.equal(files[1].data.toString('utf8'), PLUGIN_FILES[1].content)
})

test('extractTarGz: tolerates directory entries, keeps nested files', () => {
  const files = extractTarGz(
    makeTarGz([
      { content: '', path: 'sub/', typeflag: '5' },
      { content: 'nested', path: 'sub/mod.py' },
      { content: 'name: x\n', path: 'plugin.yaml' }
    ])
  )
  assert.deepEqual(files.map(file => file.path), ['sub/mod.py', 'plugin.yaml'])
})

test('extractTarGz: rejects traversal paths, symlinks, corrupt headers, non-gzip, empty', () => {
  assert.throws(() => extractTarGz(makeTarGz([{ content: 'x', path: '../evil.py' }])), /unsafe tar entry path/)
  assert.throws(() => extractTarGz(makeTarGz([{ content: '', path: 'link', typeflag: '2' }])), /unsupported tar entry type/)
  assert.throws(() => extractTarGz(makeTarGz([{ content: '', path: 'link', typeflag: '1' }])), /unsupported tar entry type/)

  const corrupt = zlib.gunzipSync(makeTarGz(PLUGIN_FILES))
  corrupt[0] ^= 0xff // flip a name byte → checksum mismatch
  assert.throws(() => extractTarGz(zlib.gzipSync(corrupt)), /checksum mismatch/)

  assert.throws(() => extractTarGz(Buffer.from('not gzip at all')))
  assert.throws(() => extractTarGz(zlib.gzipSync(Buffer.alloc(1024))), /no files/)
})

test('extractTarGz: enforces file-count and total-size caps', () => {
  const many = []
  for (let i = 0; i < MAX_FILES_PER_PLUGIN + 1; i += 1) many.push({ content: 'x', path: `f${i}.py` })
  assert.throws(() => extractTarGz(makeTarGz(many)), /max file count/)

  // The size cap fires on either surface: gunzip's maxOutputLength (a
  // RangeError before any tar parsing) or the per-file accumulation guard.
  const big = makeTarGz([{ content: 'A'.repeat(4096), path: 'big.py' }])
  assert.throws(() => extractTarGz(big, { maxTotalBytes: 1024 }), /max extracted size|larger than/)
})

// ── atomic apply ────────────────────────────────────────────────────────────

function extracted(files) {
  return files.map(file => ({ data: Buffer.from(file.content, 'utf8'), path: file.path }))
}

test('applyPlatformPlugin: installs into pluginsRoot/<name>, staging cleaned', () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  const stagingRoot = path.join(root, '.staging')
  const result = applyPlatformPlugin({
    files: extracted(PLUGIN_FILES),
    name: 'apexnodes-social-tools',
    pluginsRoot,
    stagingRoot
  })
  assert.equal(result.targetDir, path.join(pluginsRoot, 'apexnodes-social-tools'))
  assert.equal(
    fs.readFileSync(path.join(pluginsRoot, 'apexnodes-social-tools', 'plugin.yaml'), 'utf8'),
    PLUGIN_FILES[0].content
  )
  assert.equal(
    fs.readFileSync(path.join(pluginsRoot, 'apexnodes-social-tools', '__init__.py'), 'utf8'),
    PLUGIN_FILES[1].content
  )
  assert.deepEqual(fs.readdirSync(stagingRoot), []) // no staging/backup residue
})

test('applyPlatformPlugin: full replace — files dropped upstream disappear locally', () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  const target = path.join(pluginsRoot, 'p')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'stale.py'), 'old')
  applyPlatformPlugin({
    files: extracted([{ content: 'name: p\n', path: 'plugin.yaml' }]),
    name: 'p',
    pluginsRoot,
    stagingRoot: path.join(root, '.staging')
  })
  assert.deepEqual(fs.readdirSync(target), ['plugin.yaml'])
})

test('applyPlatformPlugin: mid-apply failure leaves the previous install untouched', () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  const stagingRoot = path.join(root, '.staging')
  const target = path.join(pluginsRoot, 'p')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'plugin.yaml'), 'version: old')

  assert.throws(
    () =>
      applyPlatformPlugin({
        files: [
          { data: Buffer.from('name: p'), path: 'plugin.yaml' },
          { data: Buffer.from('evil'), path: '../escape.py' } // validated at write time → throws
        ],
        name: 'p',
        pluginsRoot,
        stagingRoot
      }),
    /unsafe plugin file entry/
  )
  // Old install intact, nothing escaped, staging cleaned.
  assert.equal(fs.readFileSync(path.join(target, 'plugin.yaml'), 'utf8'), 'version: old')
  assert.equal(fs.existsSync(path.join(root, 'escape.py')), false)
  assert.deepEqual(fs.readdirSync(stagingRoot), [])
})

test('applyPlatformPlugin: refuses a package without plugin.yaml and a staging root inside plugins/', () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  assert.throws(
    () =>
      applyPlatformPlugin({
        files: extracted([{ content: 'x', path: '__init__.py' }]),
        name: 'p',
        pluginsRoot,
        stagingRoot: path.join(root, '.staging')
      }),
    /missing plugin.yaml/
  )
  // The runtime scanner walks every plugins/ subdir — staging there would be
  // discovered as a plugin. Hard error, not a silent foot-gun.
  assert.throws(
    () =>
      applyPlatformPlugin({
        files: extracted(PLUGIN_FILES),
        name: 'p',
        pluginsRoot,
        stagingRoot: path.join(pluginsRoot, '.staging')
      }),
    /outside pluginsRoot/
  )
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'p')), false)
})

// ── end-to-end sync (DI, stub transports) ───────────────────────────────────

function enabledEnv() {
  return { APEXNODES_PLATFORM_PLUGINS: '1' }
}

test('syncPlatformPlugins: happy path — downloads, verifies, installs, records state', async () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  const stagingRoot = path.join(root, '.staging')
  const packageBuffer = makeTarGz(PLUGIN_FILES)
  const entry = manifestEntryFor('apexnodes-social-tools', packageBuffer, PLUGIN_FILES)
  const fetched = { buffers: [], jsons: [] }

  const result = await syncPlatformPlugins({
    apiBase: 'https://api.apex-nodes.com',
    env: enabledEnv(),
    fetchBuffer: async url => {
      fetched.buffers.push(url)
      return packageBuffer
    },
    fetchJson: async url => {
      fetched.jsons.push(url)
      return { manifest_hash: 'mh1', plugins: [entry] }
    },
    pluginsRoot,
    stagingRoot,
    stored: null,
    token: 'jwt'
  })

  assert.equal(result.status, 'applied')
  assert.deepEqual(result.installed, ['apexnodes-social-tools'])
  assert.deepEqual(result.failed, [])
  assert.equal(result.newStored.manifestHash, 'mh1')
  assert.deepEqual(result.newStored.plugins, { 'apexnodes-social-tools': entry.sha256 })
  assert.equal(
    fs.readFileSync(path.join(pluginsRoot, 'apexnodes-social-tools', 'plugin.yaml'), 'utf8'),
    PLUGIN_FILES[0].content
  )
  // Package URL was pinned to the master base.
  assert.deepEqual(fetched.buffers, [
    `https://api.apex-nodes.com${PLATFORM_PLUGINS_PATH}/apexnodes-social-tools/package`
  ])
})

test('syncPlatformPlugins: sha256 mismatch → nothing lands on disk, manifestHash not advanced', async () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  const packageBuffer = makeTarGz(PLUGIN_FILES)
  const entry = manifestEntryFor('apexnodes-social-tools', packageBuffer, PLUGIN_FILES)
  const tampered = Buffer.from(packageBuffer)
  tampered[tampered.length - 1] ^= 0xff

  const logs = []
  const result = await syncPlatformPlugins({
    apiBase: 'https://x',
    env: enabledEnv(),
    fetchBuffer: async () => tampered,
    fetchJson: async () => ({ manifest_hash: 'mh2', plugins: [entry] }),
    log: msg => logs.push(msg),
    pluginsRoot,
    stagingRoot: path.join(root, '.staging'),
    stored: { installedAt: 1, manifestHash: 'mh-old', plugins: {} },
    token: 'jwt'
  })

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failed, ['apexnodes-social-tools'])
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'apexnodes-social-tools')), false)
  // Partial apply must NOT claim the new manifest — next boot misses the
  // fast-path and retries.
  assert.equal(result.newStored.manifestHash, 'mh-old')
  assert.ok(logs.some(msg => /sha256 mismatch/.test(msg)))
})

test('syncPlatformPlugins: size mismatch vs manifest → rejected before hashing/extraction', async () => {
  const root = tmpRoot()
  const packageBuffer = makeTarGz(PLUGIN_FILES)
  const entry = manifestEntryFor('apexnodes-social-tools', packageBuffer, PLUGIN_FILES)
  entry.size = packageBuffer.length + 1

  const result = await syncPlatformPlugins({
    apiBase: 'https://x',
    env: enabledEnv(),
    fetchBuffer: async () => packageBuffer,
    fetchJson: async () => ({ manifest_hash: 'mh3', plugins: [entry] }),
    pluginsRoot: path.join(root, 'plugins'),
    stagingRoot: path.join(root, '.staging'),
    stored: null,
    token: 'jwt'
  })
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failed, ['apexnodes-social-tools'])
})

test('syncPlatformPlugins: unchanged fast-path and up-to-date plan both skip downloads', async () => {
  const root = tmpRoot()
  const pluginsRoot = path.join(root, 'plugins')
  const packageBuffer = makeTarGz(PLUGIN_FILES)
  const entry = manifestEntryFor('apexnodes-social-tools', packageBuffer, PLUGIN_FILES)
  const bufferCalls = []

  // Server says unchanged (client sent known_hash).
  const unchanged = await syncPlatformPlugins({
    apiBase: 'https://x',
    env: enabledEnv(),
    fetchBuffer: async () => bufferCalls.push('nope'),
    fetchJson: async url => {
      assert.match(url, /known_hash=mh4/)
      return { manifest_hash: 'mh4', unchanged: true }
    },
    pluginsRoot,
    stagingRoot: path.join(root, '.staging'),
    stored: { installedAt: 1, manifestHash: 'mh4', plugins: {} },
    token: 'jwt'
  })
  assert.equal(unchanged.status, 'unchanged')

  // Full manifest but sha+dir already match → zero package downloads.
  fs.mkdirSync(path.join(pluginsRoot, 'apexnodes-social-tools'), { recursive: true })
  const upToDate = await syncPlatformPlugins({
    apiBase: 'https://x',
    env: enabledEnv(),
    fetchBuffer: async () => bufferCalls.push('nope'),
    fetchJson: async () => ({ manifest_hash: 'mh5', plugins: [entry] }),
    pluginsRoot,
    stagingRoot: path.join(root, '.staging'),
    stored: { installedAt: 1, manifestHash: 'mh4', plugins: { 'apexnodes-social-tools': entry.sha256 } },
    token: 'jwt'
  })
  assert.equal(upToDate.status, 'up-to-date')
  assert.equal(upToDate.newStored.manifestHash, 'mh5')
  assert.deepEqual(bufferCalls, [])
})

test('syncPlatformPlugins: offline/garbage manifest → fail-soft, installed set stands', async () => {
  const root = tmpRoot()
  for (const fetchJson of [
    async () => {
      throw new Error('offline')
    },
    async () => 'not json shape'
  ]) {
    const result = await syncPlatformPlugins({
      apiBase: 'https://x',
      env: enabledEnv(),
      fetchBuffer: async () => Buffer.alloc(0),
      fetchJson,
      pluginsRoot: path.join(root, 'plugins'),
      stagingRoot: path.join(root, '.staging'),
      stored: null,
      token: 'jwt'
    })
    assert.equal(result.status, 'unavailable')
  }
})

test('syncPlatformPlugins: enabled but signed out (no token) → skip, no fetch', async () => {
  const calls = []
  const result = await syncPlatformPlugins({
    apiBase: 'https://x',
    env: enabledEnv(),
    fetchBuffer: async () => calls.push('buffer'),
    fetchJson: async () => calls.push('json'),
    pluginsRoot: '/nonexistent',
    stagingRoot: '/nonexistent-staging',
    stored: null,
    token: ''
  })
  assert.equal(result.status, 'skipped')
  assert.deepEqual(calls, [])
})
