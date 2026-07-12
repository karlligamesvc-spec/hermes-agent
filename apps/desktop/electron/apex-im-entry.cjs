/**
 * apex-im-entry.cjs
 *
 * Pure, electron-free helpers for hc-417 "Desktop IM 入口" — the consumer-facing
 * page where a signed-in user connects their local agent to an IM platform
 * (飞书 first, more channels to follow) by scanning a QR / pasting one code, with
 * NO developer jargon. Kept standalone (no `require('electron')`) so it can be
 * unit-tested with `node --test`, same pattern as apex-feishu.cjs / apex-managed.cjs.
 * main.cjs requires these and wires them into the electron-coupled IPC, the
 * encrypted persistence (safeStorage, like apex-feishu.json) and the backend
 * spawn env.
 *
 * ── Why a NEW pipeline (not the hc-444 feishu bridge) ───────────────────────
 * hc-444 (apex-feishu.cjs) mirrors the user's EXISTING cloud-agent Feishu app
 * credential down to the desktop. Per the hc-417 spike, reusing that same app on
 * both the cloud agent and the desktop puts two long-connections on one Feishu
 * app, and Feishu's WS cluster then random-dispatches events between them →
 * random message loss. So hc-417 issues an INDEPENDENT Feishu app for the
 * desktop via a cloud device-code endpoint (createbot's init→begin→poll
 * primitives, credential pinned to a desktop anchor agent). This module owns
 * that separate credential store + its spawn-env injection.
 *
 * ── Storage / injection contract ────────────────────────────────────────────
 * main.cjs persists this store ENCRYPTED (Electron safeStorage — same treatment
 * as the managed relay key and the hc-444 app_secret): secret env values are
 * encrypted at rest, non-secret display/routing fields in clear. At spawn time
 * main injects the decrypted values JUST-IN-TIME into the backend env, ADD-ONLY,
 * and — because it is spread AFTER desktopFeishuSpawnEnv() — a hc-417 feishu
 * binding WINS any FEISHU_* key over the hc-444 bridge, so only ONE Feishu app's
 * credential ever reaches the runtime (the exact dual-app collision the spike
 * warned about can't happen). The runtime gates each adapter purely on the
 * PRESENCE of its env vars (gateway/config.py), and there is no hot reload — a
 * bind/unbind re-homes the backend so the change applies on the next boot.
 *
 * The secret is never written to a plaintext `.env` and never logged.
 */

// ── Channel env descriptors (the runtime contract) ──────────────────────────
// For each channel we can bind, declare the backend env keys that light up its
// adapter (gateway/config.py enables the adapter on the presence of these). Each
// field marks whether its VALUE is a secret (encrypt at rest + never log) or a
// non-secret routing/display value (clear at rest). This is the single source of
// truth the store, the encrypt layer and the spawn-env builder all read, so
// adding a channel is one descriptor entry — not scattered edits.
//
// `id` matches the runtime Platform enum value (gateway/config.py) so the live
// connection state from /api/messaging/platforms lines up by id.
const CHANNEL_ENV_DESCRIPTORS = Object.freeze({
  feishu: Object.freeze({
    // FEISHU_APP_ID is an app identifier (not a secret); FEISHU_APP_SECRET is.
    // FEISHU_DOMAIN selects feishu (China) vs lark (International).
    fields: Object.freeze([
      Object.freeze({ key: 'FEISHU_APP_ID', from: 'appId', secret: false, required: true }),
      Object.freeze({ key: 'FEISHU_APP_SECRET', from: 'appSecret', secret: true, required: true }),
      Object.freeze({ key: 'FEISHU_DOMAIN', from: 'domain', secret: false, required: false })
    ])
  })
})

// The valid Feishu domains the runtime accepts (mirrors apex-feishu.cjs).
const VALID_FEISHU_DOMAINS = new Set(['feishu', 'lark'])
const DEFAULT_FEISHU_DOMAIN = 'feishu'

function trimStr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function normalizeFeishuDomain(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase()
  return VALID_FEISHU_DOMAINS.has(raw) ? raw : DEFAULT_FEISHU_DOMAIN
}

/**
 * True when a channel id is one hc-417 knows how to inject. Unknown ids (a stale
 * or hand-edited store) are ignored everywhere.
 *
 * @param {unknown} channelId
 * @returns {boolean}
 */
function isKnownChannel(channelId) {
  return typeof channelId === 'string' && Object.prototype.hasOwnProperty.call(CHANNEL_ENV_DESCRIPTORS, channelId)
}

/**
 * Shape a raw credential object into the canonical per-channel binding the store
 * persists (BEFORE encryption). Returns null when the required fields are missing
 * so a malformed/partial credential is treated exactly like "not bound" and can
 * never half-enable an adapter. `boundAt` defaults to now unless the caller
 * carries an existing timestamp (a re-shape of an already-stored record).
 *
 * @param {string} channelId
 * @param {Record<string, unknown> | null | undefined} credential
 * @param {{ boundAt?: number }} [opts]
 * @returns {null | { channelId: string, fields: Record<string,string>, boundAt: number }}
 */
function shapeBinding(channelId, credential, opts = {}) {
  if (!isKnownChannel(channelId) || !credential || typeof credential !== 'object') {
    return null
  }

  const descriptor = CHANNEL_ENV_DESCRIPTORS[channelId]
  const fields = {}

  for (const field of descriptor.fields) {
    let value = trimStr(credential[field.from])
    if (field.key === 'FEISHU_DOMAIN') {
      // Only emit a domain when one was supplied; the runtime defaults it.
      value = trimStr(credential[field.from]) ? normalizeFeishuDomain(credential[field.from]) : ''
    }
    if (value) {
      fields[field.from] = value
    } else if (field.required) {
      // A missing REQUIRED field makes the whole binding unusable.
      return null
    }
  }

  const boundAt =
    typeof opts.boundAt === 'number' && Number.isFinite(opts.boundAt) ? opts.boundAt : Date.now()

  return { channelId, fields, boundAt }
}

/**
 * Validate + normalize the persisted apex-im-entry.json content AFTER main.cjs
 * has decrypted the secret fields in place. Any garbage (missing file, corrupt
 * JSON, tampered/unknown channels, partial records) degrades to an empty store
 * so boot can never throw over the cache. Returns a map keyed by channel id.
 *
 * @param {unknown} raw parsed file content with secret fields already decrypted
 * @returns {Record<string, { channelId: string, fields: Record<string,string>, boundAt: number }>}
 */
function normalizeStoredImEntry(raw) {
  const out = {}
  const bindings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.bindings : null
  if (!bindings || typeof bindings !== 'object') {
    return out
  }

  for (const [channelId, record] of Object.entries(bindings)) {
    if (!isKnownChannel(channelId) || !record || typeof record !== 'object') {
      continue
    }
    // Re-shape through the same required-field gate used on write, so a decrypt
    // failure that blanked a secret drops the binding instead of half-enabling.
    const shaped = shapeBinding(
      channelId,
      record.fields && typeof record.fields === 'object' ? record.fields : record,
      { boundAt: record.boundAt }
    )
    if (shaped) {
      out[channelId] = shaped
    }
  }

  return out
}

/**
 * Build the backend spawn-env fragment that lights up every bound channel's
 * adapter, from the normalized (decrypted) store. Returns an empty object when
 * nothing is bound, so a `{ ...backendEnv, ...buildImEntrySpawnEnv(store) }`
 * merge is a safe no-op. Emits ONLY the descriptor-declared keys (minimal +
 * reversible: an unbind simply stops emitting them on the next spawn).
 *
 * @param {Record<string, { fields: Record<string,string> }>} store
 * @returns {Record<string, string>}
 */
function buildImEntrySpawnEnv(store) {
  const env = {}
  if (!store || typeof store !== 'object') {
    return env
  }

  for (const [channelId, binding] of Object.entries(store)) {
    if (!isKnownChannel(channelId) || !binding || typeof binding.fields !== 'object') {
      continue
    }
    for (const field of CHANNEL_ENV_DESCRIPTORS[channelId].fields) {
      const value = trimStr(binding.fields[field.from])
      if (value) {
        env[field.key] = value
      }
    }
  }

  return env
}

/**
 * The list of channel ids that carry at least one secret field — used only by
 * the encrypt layer in main.cjs to know which stored field values to run through
 * safeStorage. Kept here so the secret classification lives with the descriptor.
 *
 * @param {string} channelId
 * @returns {string[]} the `from` keys whose values are secret
 */
function secretFieldsFor(channelId) {
  if (!isKnownChannel(channelId)) {
    return []
  }
  return CHANNEL_ENV_DESCRIPTORS[channelId].fields.filter(field => field.secret).map(field => field.from)
}

// ── Cloud device-code endpoint contract (hc-417, PENDING cloud PR) ───────────
// The cloud seat is building "issue an independent Feishu app for Desktop" using
// createbot's init→begin→poll device-code primitives. The exact paths land with
// that PR; these are the best-guess defaults and are OVERRIDABLE via env so the
// cloud PR (or a staging build) can retarget without a code change here. Until
// the endpoint is live the issue call surfaces a friendly "service unavailable"
// state in the UI (a 404 is treated as retryable) — no artificial gate.
//
//   POST {API_BASE}{ISSUE_PATH}      Bearer <login JWT>  body {}
//     → { device_code, scan_url, qr_url?, interval, expires_in }
//   POST {API_BASE}{POLL_PATH}       Bearer <login JWT>  body { device_code }
//     → { status: 'pending'|'scanned'|'authorized'|'denied'|'expired',
//         credential?: { app_id, app_secret, domain } }   // present on 'authorized'
const FEISHU_ISSUE_PATH = '/api/v1/desktop/feishu-app/issue'
const FEISHU_POLL_PATH = '/api/v1/desktop/feishu-app/poll'

/**
 * Resolve the device-code endpoint URLs for an apiBase, honoring env overrides
 * (HERMES_DESKTOP_IM_FEISHU_ISSUE_URL / _POLL_URL) so the cloud PR can pin exact
 * absolute URLs. Absent overrides, compose from apiBase + the placeholder paths.
 *
 * @param {string} apiBase e.g. https://api.apex-nodes.com
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ issueUrl: string, pollUrl: string }}
 */
function resolveFeishuIssueEndpoints(apiBase, env = process.env) {
  const base = trimTrailingSlash(apiBase)
  const issueOverride = trimStr(env && env.HERMES_DESKTOP_IM_FEISHU_ISSUE_URL)
  const pollOverride = trimStr(env && env.HERMES_DESKTOP_IM_FEISHU_POLL_URL)
  return {
    issueUrl: issueOverride || `${base}${FEISHU_ISSUE_PATH}`,
    pollUrl: pollOverride || `${base}${FEISHU_POLL_PATH}`
  }
}

/**
 * Validate + normalize the device-code INIT response into the shape the renderer
 * shows (a scan URL + a poll handle). Returns null on garbage so the IPC layer
 * reports a clean failure instead of leaking a malformed body.
 *
 * @param {unknown} body parsed JSON
 * @returns {null | { deviceCode: string, scanUrl: string, qrUrl: string, intervalMs: number, expiresInMs: number }}
 */
function parseFeishuIssueResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const deviceCode = trimStr(body.device_code)
  const scanUrl = trimStr(body.scan_url) || trimStr(body.verification_uri_complete)
  if (!deviceCode || !scanUrl) {
    return null
  }
  const intervalSec = Number(body.interval)
  const expiresSec = Number(body.expires_in)
  return {
    deviceCode,
    scanUrl,
    qrUrl: trimStr(body.qr_url),
    intervalMs: Number.isFinite(intervalSec) && intervalSec > 0 ? Math.round(intervalSec * 1000) : 3000,
    expiresInMs: Number.isFinite(expiresSec) && expiresSec > 0 ? Math.round(expiresSec * 1000) : 300000
  }
}

// The device-code poll states the renderer's state machine understands. Anything
// else the server returns is coerced to 'pending' (keep polling) so a new
// server-side status can't wedge the client into a dead end.
const FEISHU_POLL_STATES = new Set(['pending', 'scanned', 'authorized', 'denied', 'expired'])

/**
 * Validate + normalize the device-code POLL response. On 'authorized' the body
 * must carry an injectable credential (both app_id + app_secret) — otherwise the
 * status degrades to 'pending' so we never report success without a credential to
 * store. Unknown statuses degrade to 'pending'.
 *
 * @param {unknown} body parsed JSON
 * @returns {{ status: string, credential: null | { appId: string, appSecret: string, domain: string } }}
 */
function parseFeishuPollResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'pending', credential: null }
  }

  const rawStatus = String(body.status || '').trim().toLowerCase()
  const status = FEISHU_POLL_STATES.has(rawStatus) ? rawStatus : 'pending'

  if (status !== 'authorized') {
    return { status, credential: null }
  }

  const cred = body.credential && typeof body.credential === 'object' ? body.credential : {}
  const appId = trimStr(cred.app_id)
  const appSecret = trimStr(cred.app_secret)
  if (!appId || !appSecret) {
    // Authorized but no usable credential yet → keep polling, don't false-succeed.
    return { status: 'pending', credential: null }
  }

  return {
    status: 'authorized',
    credential: { appId, appSecret, domain: normalizeFeishuDomain(cred.domain) }
  }
}

module.exports = {
  CHANNEL_ENV_DESCRIPTORS,
  DEFAULT_FEISHU_DOMAIN,
  FEISHU_ISSUE_PATH,
  FEISHU_POLL_PATH,
  VALID_FEISHU_DOMAINS,
  buildImEntrySpawnEnv,
  isKnownChannel,
  normalizeFeishuDomain,
  normalizeStoredImEntry,
  parseFeishuIssueResponse,
  parseFeishuPollResponse,
  resolveFeishuIssueEndpoints,
  secretFieldsFor,
  shapeBinding
}
