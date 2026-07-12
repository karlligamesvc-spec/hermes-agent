'use strict'

/**
 * apex-platform-skills.cjs
 *
 * Platform SKILL distribution — pure, dependency-light helpers (like
 * apex-client-config.cjs). The desktop bundle ships ZERO platform skills, so a
 * desktop agent lacks the cloud steering SKILLs — notably
 * `douyin-video-transcript`, which forces a Douyin/TikTok/小红书 share link
 * through the `social_download` gateway tool instead of a browser hard-scrape
 * (the A-10 bug: the desktop agent opened a browser and hard-scraped, exactly
 * the path that SKILL forbids). The download/transcribe TOOLS already ride the
 * desktop (apexnodes-douyin-tools); this closes the missing SKILL leg.
 *
 * main.cjs wires the fetch (authed with the stored login JWT), the boot /
 * post-sign-in refresh, and the persisted manifest cache; this file holds the
 * pure logic + the fs apply:
 *   - URL + response parsing (fail-soft: any garbage → null → installed set stands)
 *   - name/path SAFETY (skills arrive over the network → strict containment; a
 *     hostile/buggy payload must never escape the skills dir)
 *   - an idempotent fs apply that writes each skill under
 *     HERMES_HOME/skills/<CATEGORY>/<name>/ — the runtime's native CATEGORIZED
 *     skill layout (siblings: apple/, mlops/, …), so platform skills never
 *     collide with a bundled flat skill and disabling the feature is a single
 *     directory removal.
 *
 * BACKEND CONTRACT (hc-520 cloud leg — hermes-cloud PR #591)
 * ----------------------------------------------------------
 *   GET {API_BASE}/api/v1/desktop/platform-skills             (JWT Bearer)
 *     → { manifest_hash, generated_at, total,
 *         skills: [ { name, version, hash, description,
 *                     files: [ { path, content } ] } ] }
 *   GET …/platform-skills?known_hash=<h>
 *     → may short-circuit to { manifest_hash, unchanged: true }
 *   401 → expired/absent JWT; treated as "nothing to sync" (installed set stands).
 *
 * The persisted cache (userData/apex-platform-skills.json) is plain JSON
 * ({ manifestHash, installedAt, count }) — the payload carries NO secrets
 * (curated Markdown; the cloud leg's red-line test forbids vendor keys), so no
 * safeStorage encryption, unlike apex-managed.json.
 */

const fs = require('fs')
const path = require('path')

const PLATFORM_SKILLS_PATH = '/api/v1/desktop/platform-skills'

// The runtime discovers skills recursively under HERMES_HOME/skills; bundled
// skills are organised by CATEGORY (skills/apple/…, skills/mlops/…). Platform
// skills get their own category so they are collision-free and removable as a
// unit. Must NOT match a bundled category name.
const PLATFORM_SKILLS_CATEGORY = 'apexnodes'

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Build the platform-skills URL for an apiBase, optionally advertising the
 * manifest hash we already hold so the server can answer `{ unchanged: true }`.
 *
 * @param {string} apiBase e.g. https://api.apex-nodes.com
 * @param {string} [knownHash] included as ?known_hash=<h> when a non-empty string
 * @returns {string}
 */
function platformSkillsUrl(apiBase, knownHash) {
  const base = trimTrailingSlash(apiBase)
  const known = typeof knownHash === 'string' ? knownHash.trim() : ''
  const query = known ? `?known_hash=${encodeURIComponent(known)}` : ''
  return `${base}${PLATFORM_SKILLS_PATH}${query}`
}

/**
 * A safe skill DIRECTORY name: a single path segment of a conservative charset,
 * never `.`/`..`, no separators. Skill names arrive from the network, so this is
 * a security gate, not cosmetics.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isSafeSkillName(name) {
  // The leading [A-Za-z0-9] anchor already rejects '.' and '..' and any name
  // starting with a separator; the class excludes '/' and '\'.
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * A safe RELATIVE file path within a skill: forward-slash separated segments of
 * a conservative charset, no absolute path, no `.`/`..`, no backslash, no NUL.
 * Guards against path traversal out of the skill directory.
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
 * Validate + normalize one skill entry from the response. Returns null for
 * anything unsafe or structurally invalid so a bad entry is dropped, never
 * written. A valid skill has a safe name, ≥1 safe text file, and a SKILL.md.
 *
 * @param {unknown} raw
 * @returns {null | { name: string, version: string, hash: string,
 *   files: { path: string, content: string }[] }}
 */
function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!isSafeSkillName(name)) return null

  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0'
  const hash = typeof raw.hash === 'string' ? raw.hash.trim() : ''

  const rawFiles = Array.isArray(raw.files) ? raw.files : []
  const files = []
  for (const entry of rawFiles) {
    if (!entry || typeof entry !== 'object') continue
    const filePath = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!isSafeRelPath(filePath) || typeof entry.content !== 'string') continue
    files.push({ content: entry.content, path: filePath })
  }
  if (!files.some(file => file.path === 'SKILL.md')) return null
  return { files, hash, name, version }
}

/**
 * Validate + normalize a platform-skills response body. Returns null on garbage
 * so callers treat any malformed body exactly like "nothing to sync" (fail-soft).
 *
 * Accepted shapes:
 *   { manifest_hash: str, skills: [...] }        → full manifest
 *   { manifest_hash: str, unchanged: true }      → not modified (fast path)
 *
 * Unknown top-level fields are ignored (forward compat).
 *
 * @param {unknown} body parsed JSON response
 * @returns {null | { manifestHash: string, unchanged: boolean,
 *   skills: { name: string, version: string, hash: string,
 *     files: { path: string, content: string }[] }[] | null }}
 */
function parsePlatformSkillsResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const manifestHash = typeof body.manifest_hash === 'string' ? body.manifest_hash.trim() : ''
  if (!manifestHash) return null

  if (body.unchanged === true) {
    return { manifestHash, skills: null, unchanged: true }
  }
  if (!Array.isArray(body.skills)) return null
  const skills = []
  for (const raw of body.skills) {
    const skill = normalizeSkill(raw)
    if (skill) skills.push(skill)
  }
  return { manifestHash, skills, unchanged: false }
}

/**
 * Should a fetched manifest be (re)applied over what we already installed? True
 * when `fetchedHash` is non-empty and differs from `appliedHash`. The server's
 * known_hash fast-path normally answers `unchanged` first; this is the belt-and-
 * braces guard for the first boot (no known_hash sent) and any hash regression.
 *
 * @param {unknown} fetchedHash
 * @param {unknown} appliedHash
 * @returns {boolean}
 */
function shouldApplyManifest(fetchedHash, appliedHash) {
  const fetched = typeof fetchedHash === 'string' ? fetchedHash.trim() : ''
  if (!fetched) return false
  const applied = typeof appliedHash === 'string' ? appliedHash.trim() : ''
  return fetched !== applied
}

/**
 * Normalize the persisted apex-platform-skills.json content. Any garbage
 * degrades to the empty state so boot never throws over the cache.
 *
 * @param {unknown} raw parsed file content
 * @returns {{ manifestHash: string, installedAt: number | null, count: number }}
 */
function normalizeStoredManifest(raw) {
  const empty = { count: 0, installedAt: null, manifestHash: '' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const manifestHash = typeof raw.manifestHash === 'string' ? raw.manifestHash.trim() : ''
  if (!manifestHash) return empty
  const installedAt = typeof raw.installedAt === 'number' && Number.isFinite(raw.installedAt) ? raw.installedAt : null
  const count = typeof raw.count === 'number' && Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : 0
  return { count, installedAt, manifestHash }
}

/**
 * Is platform-skill distribution enabled? Default ON. An explicit opt-out
 * (`APEXNODES_PLATFORM_SKILLS=0|false|off|no`) disables the feature; main.cjs
 * then reverts the desktop to the no-platform-SKILL state.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function isPlatformSkillsEnabled(env) {
  const raw = String((env && env.APEXNODES_PLATFORM_SKILLS) || '').trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

/** Absolute category directory for the platform skills under a skills root. */
function platformSkillsCategoryDir(skillsRoot) {
  return path.join(skillsRoot, PLATFORM_SKILLS_CATEGORY)
}

/**
 * Fetch + parse the platform skill manifest. NEVER throws — returns null on any
 * failure (offline, 401 expired JWT, garbage body) so the boot / post-sign-in
 * refresh degrades to the installed set. Mirrors
 * apex-client-config.cjs::fetchClientConfig, but AUTHED: main.cjs passes its
 * Bearer GET (`apexAuthGetJson`) as `fetchJson` and the stored login JWT as
 * `token`.
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.token login JWT (Bearer)
 * @param {(url: string, options?: object) => Promise<any>} opts.fetchJson
 * @param {string} [opts.knownHash] currently installed manifest hash (skip hint)
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<null | ReturnType<typeof parsePlatformSkillsResponse>>}
 */
async function fetchPlatformSkills({ apiBase, token, fetchJson, knownHash, timeoutMs = 12_000, log = () => {} }) {
  if (!apiBase || !token || typeof fetchJson !== 'function') return null
  const url = platformSkillsUrl(apiBase, knownHash)
  let body
  try {
    body = await fetchJson(url, { bearer: token, timeoutMs })
  } catch (err) {
    // 401 (expired JWT), network error, HTML gateway page, timeout → "nothing
    // new"; the installed set stands.
    log(`[platform-skills] fetch unavailable (${(err && err.message) || err}); keeping installed set`)
    return null
  }
  const parsed = parsePlatformSkillsResponse(body)
  if (!parsed) {
    log('[platform-skills] response body malformed; keeping installed set')
    return null
  }
  return parsed
}

/**
 * Write the platform skills under `<skillsRoot>/<CATEGORY>/`. Idempotent CLEAN
 * replace: the category directory is EXCLUSIVELY ours (namespace isolation), so
 * a full rewrite drops any skill the cloud removed without ever touching bundled
 * or other-category skills. Each skill name + file path is re-validated and the
 * resolved target confirmed inside the category dir (defense in depth) before
 * writing; unsafe entries are skipped and reported, never written.
 *
 * @param {object} opts
 * @param {string} opts.skillsRoot HERMES_HOME/skills
 * @param {{ name: string, files: { path: string, content: string }[] }[]} opts.skills
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ installed: string[], skippedUnsafe: string[], categoryDir: string }}
 */
function applyPlatformSkills({ skillsRoot, skills, log = () => {} }) {
  const categoryDir = platformSkillsCategoryDir(skillsRoot)
  const categoryResolved = path.resolve(categoryDir)
  fs.rmSync(categoryDir, { force: true, recursive: true })

  const installed = []
  const skippedUnsafe = []
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = skill && typeof skill.name === 'string' ? skill.name : ''
    if (!isSafeSkillName(name)) {
      skippedUnsafe.push(String(name || '<unnamed>'))
      continue
    }
    const skillDir = path.join(categoryResolved, name)
    let wroteAny = false
    for (const file of Array.isArray(skill.files) ? skill.files : []) {
      const relPath = file && typeof file.path === 'string' ? file.path : ''
      if (!isSafeRelPath(relPath)) {
        skippedUnsafe.push(`${name}/${relPath || '<nopath>'}`)
        continue
      }
      const abs = path.resolve(skillDir, relPath)
      // Belt-and-braces containment: even with the per-segment guard, refuse
      // anything that resolves outside the category dir.
      if (abs !== categoryResolved && !abs.startsWith(categoryResolved + path.sep)) {
        skippedUnsafe.push(`${name}/${relPath}`)
        continue
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, typeof file.content === 'string' ? file.content : '', 'utf8')
      wroteAny = true
    }
    if (wroteAny) installed.push(name)
  }
  log(`[platform-skills] installed ${installed.length} skill(s) under ${categoryDir}`)
  return { categoryDir, installed, skippedUnsafe }
}

/**
 * Remove the platform skill category (the OFF path). Idempotent — a missing
 * directory is a no-op. Only ever touches `<skillsRoot>/<CATEGORY>/`, never a
 * bundled or other-category skill.
 *
 * @param {object} opts
 * @param {string} opts.skillsRoot HERMES_HOME/skills
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ removed: boolean, categoryDir: string }}
 */
function removePlatformSkills({ skillsRoot, log = () => {} }) {
  const categoryDir = platformSkillsCategoryDir(skillsRoot)
  const existed = fs.existsSync(categoryDir)
  fs.rmSync(categoryDir, { force: true, recursive: true })
  if (existed) log(`[platform-skills] removed platform skill category ${categoryDir}`)
  return { categoryDir, removed: existed }
}

module.exports = {
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
}
