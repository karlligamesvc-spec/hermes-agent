'use strict'

/**
 * apex-runtime-latest.cjs
 *
 * Runtime 3-end consistency — R4 (first-install default = admin latest) + R5
 * (opt-in update of an installed desktop). Pure, electron-free helpers so they
 * are deterministic and unit-testable; main.cjs wires the IPC + bootstrap.
 *
 * WHAT THIS SOLVES
 * ----------------
 * The desktop ships a build-time runtime pin (apps/desktop/scripts/
 * write-build-stamp.cjs -> install-stamp.json: {commit, branch}). install.sh
 * installs that pinned source. Without this module a desktop is frozen on the
 * commit it was built against; runtime updates would require re-shipping the
 * app. The cloud already exposes the admin-chosen default runtime via the
 * UNAUTHENTICATED R3 endpoint:
 *
 *     GET <apiBase>/api/v1/runtime/latest?framework=hermes-agent
 *
 * which returns (app/routers/runtime_public.py):
 *   { version, framework_id, upstream_release_tag, image_tag,
 *     cos_tarball_url, cos_publish_status, compatibility_notes,
 *     config_template_version, released_at, [upstream_commit] }
 *
 * R4: at first-launch bootstrap, fetch /latest and OVERLAY the resolved pin onto
 * the baked install-stamp so a fresh machine installs the admin-current version
 * (no app re-ship). API unreachable / unpublished -> fall back to the baked
 * stamp; this module NEVER throws into the bootstrap path.
 *
 * R5: an installed desktop can opt in to update to the admin default. We do NOT
 * reuse native `hermes update` (it requires a .git, which the mainland-China /
 * COS source-tarball install does not have — it is a `git archive` extract — and
 * it defaults to pulling raw upstream/main, which a managed product must never
 * track). Instead we re-point the pin and re-run our own bootstrap/installer
 * (see main.cjs). This deviates from PD §6's original "reuse native hermes
 * update" wording for those exact reasons.
 *
 * HOW THE PIN MAPS TO THE COS OBJECT
 * ----------------------------------
 * install.sh's CN path fetches the runtime source as
 *     ${HERMES_RUNTIME_COS_BASE}/hermes-agent-${INSTALL_COMMIT:-$BRANCH}.tar.gz
 * (scripts/lib/apexnodes-region-detect.sh::apexnodes_download_runtime_tarball).
 * So install.sh's effective COS key = `--commit` when set, else `--branch`. The
 * server names the published object by upstream_commit -> upstream_release_tag
 * -> version and stores the full URL in `cos_tarball_url`. Therefore the
 * AUTHORITATIVE key is whatever sits in `cos_tarball_url`'s basename
 * (hermes-agent-<KEY>.tar.gz); we parse it from there and only fall back to the
 * structured fields when the URL is absent. We then shape {commit, branch} so
 * that install.sh reconstructs exactly that key (commit when it looks like a
 * SHA, else branch).
 */

const COMMIT_RE = /^[0-9a-f]{7,40}$/i

// Default framework filter for the /latest query. The desktop only ships the
// hermes-agent runtime; pinning the filter means a default belonging to some
// other framework yields a 404 (handled as "no update") instead of installing
// the wrong engine.
const DEFAULT_FRAMEWORK_ID = 'hermes-agent'

// Publish states the desktop is allowed to install from. A version whose COS
// tarball has not finished publishing must NOT be pinned (install.sh would 404
// on the missing object and fall back to git clone, defeating the CN path). We
// require an explicit success state.
const INSTALLABLE_COS_STATUSES = new Set(['published', 'succeeded', 'success', 'ok'])

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Extract the install.sh COS key from a cos_tarball_url. The publisher
 * (scripts/publish-runtime-tarball.sh) names the object
 * `hermes-agent-<KEY>.tar.gz`, so the key is the basename with that fixed
 * prefix/suffix stripped. Returns '' when the URL is empty or not in that
 * shape (caller then falls back to the structured fields).
 *
 * @param {string} url
 * @returns {string}
 */
function parseCosTarballKey(url) {
  const clean = String(url || '').trim()
  if (!clean) return ''
  // Drop query/fragment, take the last path segment.
  const noQuery = clean.split(/[?#]/)[0]
  const base = noQuery.split('/').filter(Boolean).pop() || ''
  const m = /^hermes-agent-(.+)\.tar\.gz$/i.exec(base)
  return m ? m[1] : ''
}

/**
 * Derive the {commit, branch, version, cosTarballUrl, compatibilityNotes,
 * cosPublishStatus, key} pin from a parsed /latest JSON body, or null when the
 * body cannot yield an installable pin.
 *
 * Rules:
 *  - The COS key is, in priority order:
 *      1. parsed from cos_tarball_url (authoritative — matches what the server
 *         actually published)
 *      2. upstream_commit
 *      3. upstream_release_tag
 *      4. version
 *  - We require either a usable cos_tarball_url with an installable
 *    cos_publish_status, OR a structured key (commit/tag) — otherwise we can't
 *    safely point install.sh at anything and return null (caller keeps the
 *    baked pin / treats as "no update").
 *  - {commit, branch} are shaped so install.sh's `${INSTALL_COMMIT:-$BRANCH}`
 *    reconstructs the key: commit=key when key looks like a SHA, else branch=key
 *    (keeping any upstream_release_tag as the branch for the non-CN git clone
 *    `--branch <tag>` path).
 *
 * @param {any} body parsed /latest response
 * @returns {null | {commit: string|null, branch: string|null, version: string|null,
 *   cosTarballUrl: string, cosPublishStatus: string|null, compatibilityNotes: string|null,
 *   key: string}}
 */
function derivePinFromLatest(body) {
  if (!body || typeof body !== 'object') return null

  const cosTarballUrl = String(body.cos_tarball_url || '').trim()
  const cosPublishStatus = body.cos_publish_status == null ? null : String(body.cos_publish_status)
  const upstreamCommit = String(body.upstream_commit || '').trim()
  const upstreamTag = String(body.upstream_release_tag || '').trim()
  const version = String(body.version || '').trim()
  const compatibilityNotes =
    body.compatibility_notes == null ? null : String(body.compatibility_notes)
  // hc-475 (F4): version-level shell↔runtime compat gate. null/absent = no gate.
  const minDesktopVersion = String(body.min_desktop_version || '').trim() || null

  const keyFromUrl = parseCosTarballKey(cosTarballUrl)

  // A published COS tarball is the strongest signal. If cos_tarball_url is set
  // we only trust it when its status says it actually published — otherwise
  // install.sh's CN fetch would 404. When there is no URL we fall back to a
  // structured key (the non-CN git path can still clone it).
  const cosUsable = Boolean(cosTarballUrl) && cosPublishStatus != null
    ? INSTALLABLE_COS_STATUSES.has(cosPublishStatus.toLowerCase())
    : false

  let key = ''
  if (cosUsable && keyFromUrl) {
    key = keyFromUrl
  } else if (upstreamCommit) {
    key = upstreamCommit
  } else if (upstreamTag) {
    key = upstreamTag
  } else if (version) {
    key = version
  }

  if (!key) return null

  const keyIsSha = COMMIT_RE.test(key)
  // commit drives install.sh's COS key (and the git-checkout --commit). When the
  // key is a tag we leave commit null and route via branch so a non-CN install
  // does `git clone --branch <tag>`.
  const commit = keyIsSha ? key : upstreamCommit && COMMIT_RE.test(upstreamCommit) ? upstreamCommit : null
  // branch: prefer an explicit release tag (correct for `git clone --branch`),
  // else the key itself when it's not a SHA, else null (install.sh defaults to
  // its own branch, but commit will be set in that case).
  const branch = upstreamTag || (!keyIsSha ? key : null)

  return {
    commit: commit || null,
    branch: branch || null,
    version: version || null,
    cosTarballUrl,
    cosPublishStatus,
    compatibilityNotes,
    minDesktopVersion,
    key
  }
}

/**
 * Parse a semver-ish version into [major, minor, patch]. Tolerant: strips a
 * leading 'v', ignores any -prerelease / +build suffix, treats a missing
 * minor/patch as 0. Returns null when there is no leading numeric major, so
 * callers can FAIL OPEN — an unparseable version must never brick an install.
 * @param {string} value
 * @returns {[number, number, number] | null}
 */
function parseSemver(value) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value || ''))
  if (!m) return null
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)]
}

/**
 * Compare two semver-ish strings. Returns -1 / 0 / 1, or null when EITHER side
 * is unparseable (the caller decides; the desktop gate treats null as "no
 * opinion" = fail open).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1 | null}
 */
function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * hc-475 (F4): does the running desktop SHELL satisfy a runtime version's
 * min_desktop_version gate? This is the single place the shell-vs-engine
 * comparison lives. FAIL OPEN by design so the gate can never become a new
 * brick vector:
 *   - no gate (minDesktopVersion null/empty)  -> true
 *   - either version unparseable              -> true  (never block on garbage)
 *   - desktopVersion >= minDesktopVersion     -> true
 *   - desktopVersion <  minDesktopVersion     -> false (BLOCK the engine update)
 * @param {string|null|undefined} desktopVersion the shell semver (app.getVersion())
 * @param {string|null|undefined} minDesktopVersion the engine's declared minimum
 * @returns {boolean}
 */
function desktopMeetsMinVersion(desktopVersion, minDesktopVersion) {
  const min = String(minDesktopVersion || '').trim()
  if (!min) return true
  const cmp = compareSemver(desktopVersion, min)
  if (cmp === null) return true
  return cmp >= 0
}

/**
 * Build the /latest URL for an apiBase.
 * @param {string} apiBase e.g. https://api.apex-nodes.com
 * @param {string} [frameworkId]
 */
function latestUrl(apiBase, frameworkId = DEFAULT_FRAMEWORK_ID) {
  const base = trimTrailingSlash(apiBase)
  const q = frameworkId ? `?framework=${encodeURIComponent(frameworkId)}` : ''
  return `${base}/api/v1/runtime/latest${q}`
}

/**
 * Fetch + resolve the admin-current runtime pin. NEVER throws — returns null on
 * any failure (offline, 404 no-default, unpublished, parse error) so callers
 * (R4 bootstrap, R5 check) degrade to the baked pin / "no update".
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {(url: string, options?: object) => Promise<any>} opts.fetchJson
 *   credential-free JSON GET (main.cjs passes fetchPublicJson)
 * @param {string} [opts.frameworkId]
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<null | ReturnType<typeof derivePinFromLatest>>}
 */
async function resolveLatestRuntimePin({
  apiBase,
  fetchJson,
  frameworkId = DEFAULT_FRAMEWORK_ID,
  timeoutMs = 10_000,
  log = () => {}
}) {
  if (!apiBase || typeof fetchJson !== 'function') return null
  const url = latestUrl(apiBase, frameworkId)
  let body
  try {
    body = await fetchJson(url, { timeoutMs })
  } catch (err) {
    // 404 (no default), network error, HTML, etc. -> treat as "no managed
    // latest available"; the baked pin stands.
    log(`[runtime-latest] /latest unavailable (${(err && err.message) || err}); using baked pin`)
    return null
  }
  const pin = derivePinFromLatest(body)
  if (!pin) {
    log('[runtime-latest] /latest returned no installable pin; using baked pin')
    return null
  }
  log(
    `[runtime-latest] resolved admin latest: version=${pin.version || '?'} key=${pin.key} ` +
      `(commit=${pin.commit ? pin.commit.slice(0, 12) : '-'}, branch=${pin.branch || '-'})`
  )
  return pin
}

/**
 * Compare a resolved latest pin against the locally installed marker to decide
 * whether an opt-in update is available (R5 read side). NEVER throws.
 *
 * "Installed key" is derived the same way install.sh keyed the source: the
 * marker's pinnedCommit when present, else pinnedBranch. A difference in key (or
 * version, when both are known) means an update is offered.
 *
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {(url: string, options?: object) => Promise<any>} opts.fetchJson
 * @param {{pinnedCommit?: string|null, pinnedBranch?: string|null, version?: string|null}|null} opts.marker
 *   the bootstrap-complete marker (main.cjs readBootstrapMarker())
 * @param {string} [opts.frameworkId]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{updateAvailable: boolean, current: object, latest: object|null, error?: string}>}
 */
async function checkForRuntimeUpdate({
  apiBase,
  fetchJson,
  marker,
  frameworkId = DEFAULT_FRAMEWORK_ID,
  desktopVersion = null,
  log = () => {}
}) {
  const installedCommit = (marker && marker.pinnedCommit) || null
  const installedBranch = (marker && marker.pinnedBranch) || null
  const installedVersion = (marker && marker.version) || null
  const installedKey = installedCommit || installedBranch || null
  const current = { commit: installedCommit, branch: installedBranch, version: installedVersion, key: installedKey }

  let pin
  try {
    pin = await resolveLatestRuntimePin({ apiBase, fetchJson, frameworkId, log })
  } catch (err) {
    // resolveLatestRuntimePin already swallows, but be defensive.
    return { updateAvailable: false, current, latest: null, error: (err && err.message) || String(err) }
  }
  if (!pin) {
    return { updateAvailable: false, current, latest: null }
  }

  const latest = {
    version: pin.version,
    commit: pin.commit,
    branch: pin.branch,
    key: pin.key,
    cosTarballUrl: pin.cosTarballUrl,
    cosPublishStatus: pin.cosPublishStatus,
    compatibilityNotes: pin.compatibilityNotes,
    minDesktopVersion: pin.minDesktopVersion
  }

  // No installed key recorded (older marker) -> we can't compare reliably; do
  // not claim an update (avoid nagging) but expose latest for the UI.
  if (!installedKey) {
    return { updateAvailable: false, current, latest }
  }

  // Primary signal: the source key differs. Secondary: when both versions are
  // known and differ, also treat as an update (covers a re-publish under the
  // same commit key with a bumped version label).
  const keyDiffers = String(installedKey) !== String(pin.key)
  const versionDiffers = Boolean(installedVersion && pin.version && installedVersion !== pin.version)
  const updateAvailable = keyDiffers || versionDiffers

  // hc-475 (F4): shell↔runtime compat gate. When there IS a newer engine but this
  // desktop shell is too old to run it (min_desktop_version), do NOT offer a
  // normal update (a click would be refused at apply time). Instead report
  // updateAvailable:false + desktopUpgradeRequired so the UI prompts the user to
  // upgrade the desktop app first. No gate / satisfied / unparseable -> unchanged.
  if (updateAvailable && !desktopMeetsMinVersion(desktopVersion, pin.minDesktopVersion)) {
    return {
      updateAvailable: false,
      current,
      latest,
      desktopUpgradeRequired: {
        minDesktopVersion: pin.minDesktopVersion,
        currentDesktopVersion: desktopVersion || null
      }
    }
  }

  return { updateAvailable, current, latest }
}

/**
 * Overlay a resolved pin onto a baked install-stamp for the bootstrap runner
 * (R4 / R5 apply). Preserves the stamp's schema/builtAt while replacing the
 * commit/branch with the admin-current values and tagging the source so the
 * marker/forensics show where the pin came from. Pure.
 *
 * When `pin` is null returns `bakedStamp` unchanged (the iron-rule fallback).
 *
 * @param {object|null} bakedStamp loadInstallStamp() result (may be null in dev)
 * @param {ReturnType<typeof derivePinFromLatest>|null} pin
 * @param {string} [source] marker source tag (e.g. 'api-latest', 'opt-in-update')
 * @returns {object|null}
 */
function overlayStampWithPin(bakedStamp, pin, source = 'api-latest') {
  if (!pin) return bakedStamp || null
  const base = bakedStamp && typeof bakedStamp === 'object' ? bakedStamp : {}
  // install.sh requires a commit for the gitless COS path and the git-checkout
  // --commit; when the pin is tag-only we keep the baked commit as a last-resort
  // value but set the branch to the tag so the git clone `--branch <tag>` lands
  // on it. (The CN COS path keys by branch in that case.)
  const commit = pin.commit || base.commit || null
  const branch = pin.branch || base.branch || null
  return {
    ...base,
    commit,
    branch,
    version: pin.version || base.version || null,
    source
  }
}

module.exports = {
  COMMIT_RE,
  DEFAULT_FRAMEWORK_ID,
  INSTALLABLE_COS_STATUSES,
  parseCosTarballKey,
  derivePinFromLatest,
  parseSemver,
  compareSemver,
  desktopMeetsMinVersion,
  latestUrl,
  resolveLatestRuntimePin,
  checkForRuntimeUpdate,
  overlayStampWithPin
}
