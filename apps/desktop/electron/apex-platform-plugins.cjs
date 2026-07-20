'use strict'

/**
 * apex-platform-plugins.cjs
 *
 * Platform runtime-PLUGIN distribution (hc-564, 机制 C) — pure, dependency-light
 * helpers in the apex-platform-skills.cjs mold. Desktop plugins today only move
 * on the engine release train (fork `plugins/`), which is the day/week-scale
 * drift the hc-561 audit measured. This channel pulls per-plugin archives from
 * master and drops them under HERMES_HOME/plugins/<name>, where the runtime's
 * native user>bundled override (hermes_cli/plugins.py: user plugins take
 * precedence over bundled on key collision) makes them win with ZERO upstream
 * changes. A dropped plugin loads at the NEXT gateway restart — nothing here
 * executes downloaded content.
 *
 * ⚠️ DEFAULT OFF — the inverse of the skills channel. `APEXNODES_PLATFORM_PLUGINS`
 * must be EXPLICITLY set to 1/true/on/yes to enable; unset/anything else means
 * the sync entrypoint returns immediately with ZERO network calls and ZERO fs
 * writes (guarded by a P0-style test). Flipping the switch back off does NOT
 * remove already-installed files in v1 (no auto-recycle — plugins are live code
 * a running gateway may have loaded; silent deletion is the riskier move); the
 * sync logs a hint that files remain instead.
 *
 * main.cjs wires the fetch (stored login JWT), the boot / post-sign-in triggers
 * and the persisted state (userData/apex-platform-plugins.json); this file holds
 * the pure logic + the fs apply:
 *   - URL building PINNED to the master apiBase (package URLs are derived from
 *     apiBase + a validated plugin name only — never taken from the manifest)
 *   - manifest parsing (fail-soft: any garbage → null → installed set stands)
 *   - sha256 verification of every downloaded archive BEFORE anything touches
 *     disk (the manifest entry is the truth anchor)
 *   - a strict in-process ustar+gzip extractor (regular files only; symlinks /
 *     hardlinks / devices / PAX specials are rejected wholesale; per-entry path
 *     safety + size caps — a hostile archive must never escape the plugin dir)
 *   - an ATOMIC apply: extract to a staging dir OUTSIDE plugins/ (the runtime
 *     scanner walks every plugins/ subdir, so staging must not live there),
 *     then backup-swap-rename; any failure restores the previous install.
 *
 * BACKEND CONTRACT (hc-564 cloud leg — hermes-cloud `app/routers/desktop_platform_plugins.py`)
 * -------------------------------------------------------------------------------------------
 *   GET {API_BASE}/api/v1/desktop/platform-plugins                (JWT Bearer)
 *     → { manifest_hash, generated_at, total,
 *         plugins: [ { name, version, description, sha256, size, files } ] }
 *   GET …/platform-plugins?known_hash=<h>
 *     → may short-circuit to { manifest_hash, unchanged: true }
 *   GET …/platform-plugins/<name>/package                        (JWT Bearer)
 *     → deterministic tar.gz bytes; sha256(bytes) === the manifest entry's sha256
 *   401 → expired/absent JWT; treated as "nothing to sync" (installed set stands).
 *
 * The persisted state (userData/apex-platform-plugins.json) is plain JSON
 * ({ manifestHash, installedAt, plugins: { <name>: <sha256> } }) — no secrets,
 * so no safeStorage encryption (same reasoning as apex-platform-skills.json).
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const PLATFORM_PLUGINS_PATH = '/api/v1/desktop/platform-plugins'

// Network-payload bounds (zip-bomb / runaway guard). The v1 trio is < 200KB
// each; these caps are generous headroom, not tuning knobs.
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
const MAX_FILES_PER_PLUGIN = 512

const TAR_BLOCK = 512

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Is platform-plugin distribution enabled? DEFAULT OFF — the deliberate inverse
 * of isPlatformSkillsEnabled (skills are curated Markdown, default on; plugins
 * are code, opt-in). Only an explicit `APEXNODES_PLATFORM_PLUGINS=1|true|on|yes`
 * enables; unset, empty, or anything else (including typos) stays off, so the
 * shipped default behaves exactly like a build without this feature.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function isPlatformPluginsEnabled(env) {
  const raw = String((env && env.APEXNODES_PLATFORM_PLUGINS) || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

/**
 * A safe plugin DIRECTORY name: single path segment, conservative charset,
 * never `.`/`..`, no separators. Names arrive from the network → security gate.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isSafePluginName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * A safe RELATIVE file path within a plugin: forward-slash segments of a
 * conservative charset, no absolute path, no `.`/`..`, no backslash, no NUL.
 *
 * @param {unknown} relPath
 * @returns {boolean}
 */
function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false
  if (relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) return false
  return relPath.split('/').every(segment => segment !== '' && /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..')
}

/**
 * Manifest URL for an apiBase, optionally advertising the manifest hash we
 * already applied so the server can answer `{ unchanged: true }`.
 *
 * @param {string} apiBase e.g. https://api.apex-nodes.com
 * @param {string} [knownHash]
 * @returns {string}
 */
function platformPluginsUrl(apiBase, knownHash) {
  const base = trimTrailingSlash(apiBase)
  const known = typeof knownHash === 'string' ? knownHash.trim() : ''
  const query = known ? `?known_hash=${encodeURIComponent(known)}` : ''
  return `${base}${PLATFORM_PLUGINS_PATH}${query}`
}

/**
 * Package-download URL for ONE plugin. Derived exclusively from the master
 * apiBase + a validated plugin name — the manifest can NEVER redirect a
 * download to another host (domain pinning). Null for an unsafe name.
 *
 * @param {string} apiBase
 * @param {string} name plugin directory name from the manifest
 * @returns {string | null}
 */
function platformPluginPackageUrl(apiBase, name) {
  if (!isSafePluginName(name)) return null
  const base = trimTrailingSlash(apiBase)
  return `${base}${PLATFORM_PLUGINS_PATH}/${encodeURIComponent(name)}/package`
}

/**
 * Validate + normalize one manifest plugin entry. Null for anything unsafe or
 * structurally invalid (dropped, never fetched). A valid entry has a safe name,
 * a 64-hex sha256, a plausible bounded size, and a safe files list including
 * plugin.yaml (the runtime scanner's own validity marker).
 *
 * @param {unknown} raw
 * @returns {null | { name: string, version: string, sha256: string, size: number, files: string[] }}
 */
function normalizePluginEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!isSafePluginName(name)) return null

  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null

  const size = raw.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_PACKAGE_BYTES) return null

  const rawFiles = Array.isArray(raw.files) ? raw.files : []
  const files = []
  for (const entry of rawFiles) {
    const relPath = typeof entry === 'string' ? entry.trim() : ''
    if (!isSafeRelPath(relPath)) continue
    files.push(relPath)
  }
  if (!files.includes('plugin.yaml')) return null

  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0'
  return { files, name, sha256, size, version }
}

/**
 * Validate + normalize a platform-plugins manifest body. Null on garbage so
 * callers treat any malformed body exactly like "nothing to sync" (fail-soft).
 *
 * Accepted shapes:
 *   { manifest_hash: str, plugins: [...] }    → full manifest
 *   { manifest_hash: str, unchanged: true }   → not modified (fast path)
 *
 * Unknown top-level fields are ignored (forward compat).
 *
 * @param {unknown} body parsed JSON response
 * @returns {null | { manifestHash: string, unchanged: boolean,
 *   plugins: ReturnType<typeof normalizePluginEntry>[] | null }}
 */
function parsePlatformPluginsManifest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const manifestHash = typeof body.manifest_hash === 'string' ? body.manifest_hash.trim() : ''
  if (!manifestHash) return null

  if (body.unchanged === true) {
    return { manifestHash, plugins: null, unchanged: true }
  }
  if (!Array.isArray(body.plugins)) return null
  const plugins = []
  for (const raw of body.plugins) {
    const entry = normalizePluginEntry(raw)
    if (entry) plugins.push(entry)
  }
  return { manifestHash, plugins, unchanged: false }
}

/**
 * Normalize the persisted apex-platform-plugins.json content. Any garbage
 * degrades to the empty state so boot never throws over the cache.
 *
 * @param {unknown} raw parsed file content
 * @returns {{ manifestHash: string, installedAt: number | null, plugins: Record<string, string> }}
 */
function normalizeStoredPluginsState(raw) {
  const empty = { installedAt: null, manifestHash: '', plugins: {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const manifestHash = typeof raw.manifestHash === 'string' ? raw.manifestHash.trim() : ''
  const installedAt = typeof raw.installedAt === 'number' && Number.isFinite(raw.installedAt) ? raw.installedAt : null
  const plugins = {}
  const rawPlugins = raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins) ? raw.plugins : {}
  for (const [name, sha] of Object.entries(rawPlugins)) {
    if (!isSafePluginName(name)) continue
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha.trim().toLowerCase())) continue
    plugins[name] = sha.trim().toLowerCase()
  }
  // A state with neither a manifest hash nor any per-plugin record is empty.
  if (!manifestHash && Object.keys(plugins).length === 0) return empty
  return { installedAt, manifestHash, plugins }
}

/** @param {Buffer} buffer @returns {string} lowercase hex sha256 */
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Which manifest plugins need (re)installing? A plugin is up to date only when
 * the recorded sha256 matches AND its directory actually exists (a user who
 * deleted the dir gets it back). Pure fs-read; no writes.
 *
 * @param {object} opts
 * @param {{ name: string, sha256: string }[]} opts.plugins normalized manifest entries
 * @param {Record<string, string>} opts.storedPlugins name → installed sha256
 * @param {string} opts.pluginsRoot HERMES_HOME/plugins
 * @returns {{ toInstall: any[], upToDate: string[] }}
 */
function planPluginSync({ plugins, storedPlugins, pluginsRoot }) {
  const toInstall = []
  const upToDate = []
  for (const entry of Array.isArray(plugins) ? plugins : []) {
    const recorded = storedPlugins && storedPlugins[entry.name]
    const present = fs.existsSync(path.join(pluginsRoot, entry.name))
    if (recorded === entry.sha256 && present) {
      upToDate.push(entry.name)
    } else {
      toInstall.push(entry)
    }
  }
  return { toInstall, upToDate }
}

function parseOctal(buffer, start, length) {
  const text = buffer.slice(start, start + length).toString('latin1').replace(/\0/g, ' ').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) return NaN
  return parseInt(text, 8)
}

function tarEntryName(block) {
  const name = block.slice(0, 100).toString('utf8').replace(/\0+$/, '')
  const magic = block.slice(257, 262).toString('latin1')
  if (magic === 'ustar') {
    const prefix = block.slice(345, 500).toString('utf8').replace(/\0+$/, '')
    if (prefix) return `${prefix}/${name}`
  }
  return name
}

function tarChecksumValid(block) {
  const recorded = parseOctal(block, 148, 8)
  if (Number.isNaN(recorded)) return false
  let sum = 0
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i]
  }
  return sum === recorded
}

/**
 * STRICT in-process tar.gz extractor for the deterministic archives the cloud
 * packager emits (Python tarfile USTAR format, regular files only). Throws on
 * ANYTHING outside that envelope — symlinks, hardlinks, devices, PAX/GNU
 * long-name specials, unsafe paths, corrupt headers, cap overruns — so a
 * hostile or corrupted archive is rejected wholesale, never partially written
 * (extraction is memory-only; callers write via applyPlatformPlugin).
 *
 * Directory entries (typeflag '5') are tolerated and skipped: parents are
 * created from file paths at apply time.
 *
 * @param {Buffer} packageBuffer tar.gz bytes (already sha256-verified)
 * @param {object} [caps]
 * @param {number} [caps.maxTotalBytes]
 * @param {number} [caps.maxFiles]
 * @returns {{ path: string, data: Buffer }[]}
 */
function extractTarGz(packageBuffer, { maxTotalBytes = MAX_EXTRACTED_BYTES, maxFiles = MAX_FILES_PER_PLUGIN } = {}) {
  const tar = zlib.gunzipSync(packageBuffer, { maxOutputLength: maxTotalBytes + 4 * TAR_BLOCK })
  const files = []
  let totalBytes = 0
  let offset = 0
  while (offset + TAR_BLOCK <= tar.length) {
    const block = tar.slice(offset, offset + TAR_BLOCK)
    if (block.every(byte => byte === 0)) break // end-of-archive marker
    if (!tarChecksumValid(block)) throw new Error(`tar header checksum mismatch at offset ${offset}`)

    const name = tarEntryName(block)
    const size = parseOctal(block, 124, 12)
    if (Number.isNaN(size) || size < 0) throw new Error(`tar entry has invalid size: ${name}`)
    const typeflag = String.fromCharCode(block[156])

    const dataStart = offset + TAR_BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error(`tar entry truncated: ${name}`)

    if (typeflag === '5') {
      // Directory — tolerated, skipped (must still be a safe path).
      if (!isSafeRelPath(name.replace(/\/+$/, ''))) throw new Error(`unsafe tar directory path: ${name}`)
      if (size !== 0) throw new Error(`tar directory entry with payload: ${name}`)
    } else if (typeflag === '0' || typeflag === '\0') {
      if (!isSafeRelPath(name)) throw new Error(`unsafe tar entry path: ${name}`)
      totalBytes += size
      if (files.length + 1 > maxFiles) throw new Error(`tar exceeds max file count (${maxFiles})`)
      if (totalBytes > maxTotalBytes) throw new Error(`tar exceeds max extracted size (${maxTotalBytes})`)
      files.push({ data: Buffer.from(tar.slice(dataStart, dataEnd)), path: name })
    } else {
      // Symlink / hardlink / device / FIFO / PAX / GNU special → reject wholesale.
      throw new Error(`unsupported tar entry type '${typeflag}' for ${name}`)
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  if (files.length === 0) throw new Error('tar archive contains no files')
  return files
}

/**
 * Atomically install ONE plugin's extracted files under
 * `<pluginsRoot>/<name>`. All-or-nothing (unlike the skills channel's
 * skip-and-continue: a plugin is a code unit — a partial install is worse
 * than none):
 *
 *   1. every file is written into a fresh staging dir under `stagingRoot`
 *      (which MUST live outside pluginsRoot — the runtime scanner walks every
 *      pluginsRoot subdir, and a half-written staging dir with a plugin.yaml
 *      would be discovered as a plugin);
 *   2. the previous install (if any) is renamed aside as a backup;
 *   3. staging is renamed into place;
 *   4. the backup is deleted.
 *
 * Any failure before step 3 leaves the previous install untouched; a failure
 * AT step 3 restores the backup. Staging/backup dirs are always cleaned up.
 * Throws on failure (callers fail-soft per plugin). Nothing is ever executed.
 *
 * @param {object} opts
 * @param {string} opts.pluginsRoot HERMES_HOME/plugins
 * @param {string} opts.stagingRoot scratch dir on the SAME volume, outside pluginsRoot
 * @param {string} opts.name validated plugin name
 * @param {{ path: string, data: Buffer }[]} opts.files extracted archive entries
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ targetDir: string, fileCount: number }}
 */
function applyPlatformPlugin({ pluginsRoot, stagingRoot, name, files, log = () => {} }) {
  if (!isSafePluginName(name)) throw new Error(`unsafe plugin name: ${name}`)
  if (!Array.isArray(files) || files.length === 0) throw new Error(`no files to install for ${name}`)
  if (!files.some(file => file.path === 'plugin.yaml')) throw new Error(`plugin package missing plugin.yaml: ${name}`)

  const pluginsRootResolved = path.resolve(pluginsRoot)
  const stagingRootResolved = path.resolve(stagingRoot)
  if (stagingRootResolved === pluginsRootResolved || stagingRootResolved.startsWith(pluginsRootResolved + path.sep)) {
    throw new Error('stagingRoot must live outside pluginsRoot (runtime scans every plugins/ subdir)')
  }

  const unique = `${name}-${process.pid.toString(36)}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  const stagingDir = path.join(stagingRootResolved, `stage-${unique}`)
  const backupDir = path.join(stagingRootResolved, `backup-${unique}`)
  const targetDir = path.join(pluginsRootResolved, name)
  const stagingDirResolved = path.resolve(stagingDir)

  try {
    fs.mkdirSync(stagingDir, { recursive: true })
    for (const file of files) {
      const relPath = file && typeof file.path === 'string' ? file.path : ''
      if (!isSafeRelPath(relPath) || !Buffer.isBuffer(file.data)) throw new Error(`unsafe plugin file entry: ${name}/${relPath || '<nopath>'}`)
      const abs = path.resolve(stagingDirResolved, relPath)
      // Belt-and-braces containment: refuse anything resolving outside staging.
      if (abs !== stagingDirResolved && !abs.startsWith(stagingDirResolved + path.sep)) {
        throw new Error(`plugin file escapes staging dir: ${name}/${relPath}`)
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, file.data)
    }

    fs.mkdirSync(pluginsRootResolved, { recursive: true })
    const hadPrevious = fs.existsSync(targetDir)
    if (hadPrevious) fs.renameSync(targetDir, backupDir)
    try {
      fs.renameSync(stagingDir, targetDir)
    } catch (error) {
      // Swap failed after the old install moved aside — restore it.
      if (hadPrevious) {
        try {
          fs.renameSync(backupDir, targetDir)
        } catch {
          log(`[platform-plugins] RESTORE FAILED for ${name}; previous install left at ${backupDir}`)
        }
      }
      throw error
    }
    fs.rmSync(backupDir, { force: true, recursive: true })
    return { fileCount: files.length, targetDir }
  } finally {
    fs.rmSync(stagingDir, { force: true, recursive: true })
  }
}

/**
 * The whole sync, dependency-injected (apex-bundle-install.cjs mold) so the
 * OFF-guard, diff, verify and atomicity are all unit-testable without electron
 * or the network. main.cjs supplies the real transports + persisted state and
 * writes back `newStored` when returned.
 *
 * FIRST GATE — the P0 contract: when `APEXNODES_PLATFORM_PLUGINS` is not
 * explicitly enabled this returns `{ status: 'disabled' }` having touched
 * NOTHING: no fetch, no fs read/write. (The only side channel is one `log`
 * line, emitted ONLY when a previous enable left installed state behind —
 * the "switch flipped off, files remain" hint; v1 never auto-removes.)
 *
 * Per-plugin failures are fail-soft: verified installs stick, failed ones keep
 * their previous version, and `newStored.manifestHash` only advances when EVERY
 * planned install succeeded (otherwise the next boot's known_hash misses the
 * fast-path and retries the failed ones).
 *
 * @param {object} opts
 * @param {Record<string, string | undefined>} opts.env
 * @param {string} opts.apiBase master base — the ONLY host ever contacted
 * @param {string} opts.token login JWT (Bearer)
 * @param {(url: string, options?: object) => Promise<any>} opts.fetchJson authed JSON GET
 * @param {(url: string, options?: object) => Promise<Buffer>} opts.fetchBuffer authed binary GET
 * @param {string} opts.pluginsRoot HERMES_HOME/plugins
 * @param {string} opts.stagingRoot scratch dir outside pluginsRoot, same volume
 * @param {unknown} opts.stored persisted state (normalized here)
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ status: string, installed?: string[], failed?: string[],
 *   manifestHash?: string, newStored?: object }>}
 */
async function syncPlatformPlugins({
  env,
  apiBase,
  token,
  fetchJson,
  fetchBuffer,
  pluginsRoot,
  stagingRoot,
  stored,
  timeoutMs = 30_000,
  log = () => {}
}) {
  const state = normalizeStoredPluginsState(stored)

  if (!isPlatformPluginsEnabled(env)) {
    if (state.manifestHash || Object.keys(state.plugins).length) {
      log('[platform-plugins] disabled via APEXNODES_PLATFORM_PLUGINS; previously installed plugins left in place (v1 keeps files; remove manually if needed)')
    }
    return { status: 'disabled' }
  }

  if (!apiBase || !token || typeof fetchJson !== 'function' || typeof fetchBuffer !== 'function') {
    log('[platform-plugins] enabled but missing apiBase/JWT/transport; skipping')
    return { status: 'skipped' }
  }

  let body
  try {
    body = await fetchJson(platformPluginsUrl(apiBase, state.manifestHash), { bearer: token, timeoutMs })
  } catch (err) {
    log(`[platform-plugins] manifest unavailable (${(err && err.message) || err}); keeping installed set`)
    return { status: 'unavailable' }
  }
  const manifest = parsePlatformPluginsManifest(body)
  if (!manifest) {
    log('[platform-plugins] manifest body malformed; keeping installed set')
    return { status: 'unavailable' }
  }
  if (manifest.unchanged) {
    log(`[platform-plugins] manifest ${manifest.manifestHash.slice(0, 12)} unchanged`)
    return { manifestHash: manifest.manifestHash, status: 'unchanged' }
  }

  const plan = planPluginSync({ plugins: manifest.plugins, pluginsRoot, storedPlugins: state.plugins })
  const installedMap = {}
  for (const name of plan.upToDate) installedMap[name] = state.plugins[name]

  // Plugins that vanished from the manifest: v1 keeps their files (no
  // auto-recycle — same policy as the OFF switch) but drops them from state.
  for (const name of Object.keys(state.plugins)) {
    if (!manifest.plugins.some(entry => entry.name === name)) {
      log(`[platform-plugins] ${name} no longer distributed; files left in place`)
    }
  }

  const installed = []
  const failed = []
  for (const entry of plan.toInstall) {
    const url = platformPluginPackageUrl(apiBase, entry.name)
    if (!url) {
      failed.push(entry.name)
      continue
    }
    try {
      const packageBuffer = await fetchBuffer(url, { bearer: token, maxBytes: MAX_PACKAGE_BYTES, timeoutMs })
      if (!Buffer.isBuffer(packageBuffer) || packageBuffer.length !== entry.size) {
        throw new Error(`size mismatch (${packageBuffer ? packageBuffer.length : 'no'} bytes, manifest says ${entry.size})`)
      }
      const digest = sha256Hex(packageBuffer)
      if (digest !== entry.sha256) {
        throw new Error(`sha256 mismatch (${digest.slice(0, 12)}… vs manifest ${entry.sha256.slice(0, 12)}…)`)
      }
      const files = extractTarGz(packageBuffer)
      applyPlatformPlugin({ files, log, name: entry.name, pluginsRoot, stagingRoot })
      installedMap[entry.name] = entry.sha256
      installed.push(entry.name)
      log(`[platform-plugins] installed ${entry.name}@${entry.version} (${entry.sha256.slice(0, 12)}…)`)
    } catch (err) {
      failed.push(entry.name)
      log(`[platform-plugins] ${entry.name} not installed (${(err && err.message) || err}); previous version stands`)
    }
  }

  const complete = failed.length === 0
  const newStored = {
    installedAt: Date.now(),
    // Only a FULLY applied manifest may claim its hash — a partial apply must
    // miss the known_hash fast-path next boot so the failed plugins retry.
    manifestHash: complete ? manifest.manifestHash : state.manifestHash,
    plugins: installedMap
  }
  return {
    failed,
    installed,
    manifestHash: manifest.manifestHash,
    newStored,
    status: complete ? (installed.length ? 'applied' : 'up-to-date') : 'partial'
  }
}

module.exports = {
  applyPlatformPlugin,
  extractTarGz,
  isPlatformPluginsEnabled,
  isSafePluginName,
  isSafeRelPath,
  MAX_EXTRACTED_BYTES,
  MAX_FILES_PER_PLUGIN,
  MAX_PACKAGE_BYTES,
  normalizePluginEntry,
  normalizeStoredPluginsState,
  parsePlatformPluginsManifest,
  planPluginSync,
  PLATFORM_PLUGINS_PATH,
  platformPluginPackageUrl,
  platformPluginsUrl,
  sha256Hex,
  syncPlatformPlugins
}
