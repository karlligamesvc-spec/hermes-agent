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
    // FEISHU_ALLOWED_USERS is the QR scanner's own Feishu open_id (not a secret):
    // it seeds the gateway-level DM allowlist (gateway/authz_mixin, keyed on the
    // FEISHU_ALLOWED_USERS env) so the owner can message the freshly-bound bot
    // immediately instead of hitting the runtime's default `pairing` gate.
    // FEISHU_HOME_CHANNEL is that same open_id — the owner-DM target for
    // proactive/cron sends. Feishu has NO adapter dm_policy (contrast the weixin
    // trio below): the gateway allowlist IS the mechanism, so these two non-secret
    // routing keys are all it needs — the cloud credentials endpoint supplies them.
    fields: Object.freeze([
      Object.freeze({ key: 'FEISHU_APP_ID', from: 'appId', secret: false, required: true }),
      Object.freeze({ key: 'FEISHU_APP_SECRET', from: 'appSecret', secret: true, required: true }),
      Object.freeze({ key: 'FEISHU_DOMAIN', from: 'domain', secret: false, required: false }),
      Object.freeze({ key: 'FEISHU_ALLOWED_USERS', from: 'allowedUsers', secret: false, required: false }),
      Object.freeze({ key: 'FEISHU_HOME_CHANNEL', from: 'homeChannel', secret: false, required: false })
    ])
  }),
  // 个人微信 (Tencent iLink bot) — hc-538. WEIXIN_TOKEN is the only secret;
  // WEIXIN_ACCOUNT_ID is the bot account id (not a secret) and WEIXIN_BASE_URL
  // is the optional iLink host. The runtime gates the adapter purely on
  // WEIXIN_TOKEN+WEIXIN_ACCOUNT_ID presence (gateway/config.py). The routing
  // trio (WEIXIN_DM_POLICY/WEIXIN_ALLOWED_USERS/WEIXIN_HOME_CHANNEL) mirrors the
  // cloud persona container's env so a desktop bot answers its owner
  // immediately (allowlist seeded with the QR scanner) instead of the runtime's
  // default `pairing` mode — the cloud credentials endpoint supplies them.
  weixin: Object.freeze({
    fields: Object.freeze([
      Object.freeze({ key: 'WEIXIN_ACCOUNT_ID', from: 'accountId', secret: false, required: true }),
      Object.freeze({ key: 'WEIXIN_TOKEN', from: 'token', secret: true, required: true }),
      Object.freeze({ key: 'WEIXIN_BASE_URL', from: 'baseUrl', secret: false, required: false }),
      Object.freeze({ key: 'WEIXIN_DM_POLICY', from: 'dmPolicy', secret: false, required: false }),
      Object.freeze({ key: 'WEIXIN_ALLOWED_USERS', from: 'allowedUsers', secret: false, required: false }),
      Object.freeze({ key: 'WEIXIN_HOME_CHANNEL', from: 'homeChannel', secret: false, required: false })
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

// ── Cloud provisioning endpoint contract (hc-417 v2, LIVE) ──────────────────
// The cloud leg landed as hermes-cloud PR #595 (+ #600 audit fixes): the
// scheduler registers an INDEPENDENT Feishu app scoped to the user's Desktop
// anchor agent via a device-code flow it drives server-side. The desktop is a
// thin consumer of four JWT-authed endpoints (app/routers/desktop.py):
//
//   POST   {API_BASE}/api/v1/desktop/feishu/provision            body {}
//     → { provision_id, qr_url, expires_in, interval }
//       (qr_url is the SCAN LINK string — render it as a QR locally;
//        429 = another flow in flight, 502 = Feishu upstream failure)
//   GET    {API_BASE}/api/v1/desktop/feishu/provision/{provision_id}
//     → { status: 'pending'|'success'|'denied'|'expired', message?, agent_name? }
//       (NEVER carries the credential; 404 = flow unknown/lost → expired)
//   GET    {API_BASE}/api/v1/desktop/feishu/credentials
//     → { app_id, app_secret, domain, agent_name?, credential_status? }
//       (404 = not provisioned yet)
//   DELETE {API_BASE}/api/v1/desktop/feishu/entry
//     → { ok, app_id }   (404 = nothing bound)
const FEISHU_PROVISION_PATH = '/api/v1/desktop/feishu/provision'
const FEISHU_PROVISION_CREDENTIALS_PATH = '/api/v1/desktop/feishu/credentials'
const FEISHU_PROVISION_ENTRY_PATH = '/api/v1/desktop/feishu/entry'

// hc-538: the WeChat (iLink) cloud leg — same four-endpoint contract as feishu
// (hermes-cloud app/routers/desktop.py), so the provision START + STATUS
// responses parse with the SHARED shape parsers below; only the credentials
// body differs (WeChat bot fields, not feishu app fields).
const WEIXIN_PROVISION_PATH = '/api/v1/desktop/weixin/provision'
const WEIXIN_PROVISION_CREDENTIALS_PATH = '/api/v1/desktop/weixin/credentials'
const WEIXIN_PROVISION_ENTRY_PATH = '/api/v1/desktop/weixin/entry'

// Hosts the provisioning endpoints are allowed to live on. These calls carry
// the login JWT and (credentials) receive an app secret, so a poisoned env
// override / apiBase must not be able to point them at an arbitrary host.
// Loopback is allowed for local cloud development.
const ALLOWED_PROVISION_APEX_DOMAIN = 'apex-nodes.com'
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * True when a provisioning URL is allowed to be called: https on
 * apex-nodes.com (or a subdomain), or http(s) on loopback for development.
 * Anything else — other hosts, other protocols, unparseable strings — is
 * rejected so the JWT / app secret can never travel to a foreign host.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedFeishuProvisionUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return false
  }
  const hostname = parsed.hostname.toLowerCase()
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  }
  if (parsed.protocol !== 'https:') {
    return false
  }
  return hostname === ALLOWED_PROVISION_APEX_DOMAIN || hostname.endsWith(`.${ALLOWED_PROVISION_APEX_DOMAIN}`)
}

/**
 * Resolve the hc-417 provisioning endpoint URLs for an apiBase, honoring env
 * overrides (HERMES_DESKTOP_IM_FEISHU_PROVISION_URL / _CREDENTIALS_URL /
 * _ENTRY_URL) so a staging build can pin exact absolute URLs. Every resolved
 * URL — override or composed — still has to pass isAllowedFeishuProvisionUrl
 * at the call site; the override is a retargeting aid, not an allowlist escape.
 *
 * @param {string} apiBase e.g. https://apex-nodes.com/api → https://apex-nodes.com
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ provisionUrl: string, credentialsUrl: string, entryUrl: string }}
 */
function resolveFeishuProvisionEndpoints(apiBase, env = process.env) {
  const base = trimTrailingSlash(apiBase)
  const provisionOverride = trimStr(env && env.HERMES_DESKTOP_IM_FEISHU_PROVISION_URL)
  const credentialsOverride = trimStr(env && env.HERMES_DESKTOP_IM_FEISHU_CREDENTIALS_URL)
  const entryOverride = trimStr(env && env.HERMES_DESKTOP_IM_FEISHU_ENTRY_URL)
  return {
    provisionUrl: provisionOverride || `${base}${FEISHU_PROVISION_PATH}`,
    credentialsUrl: credentialsOverride || `${base}${FEISHU_PROVISION_CREDENTIALS_PATH}`,
    entryUrl: entryOverride || `${base}${FEISHU_PROVISION_ENTRY_PATH}`
  }
}

/**
 * Build the poll URL for one provision flow: GET {provisionUrl}/{provision_id}.
 *
 * @param {string} provisionUrl the resolved POST .../feishu/provision URL
 * @param {string} provisionId
 * @returns {string}
 */
function feishuProvisionPollUrl(provisionUrl, provisionId) {
  return `${trimTrailingSlash(provisionUrl)}/${encodeURIComponent(String(provisionId || ''))}`
}

/**
 * Validate + normalize the provision START response (POST .../feishu/provision)
 * into the shape the renderer shows: a poll handle + the scan link to render as
 * a QR. Returns null on garbage so the IPC layer reports a clean failure
 * instead of leaking a malformed body.
 *
 * @param {unknown} body parsed JSON
 * @returns {null | { provisionId: string, qrUrl: string, intervalMs: number, expiresInMs: number }}
 */
function parseFeishuProvisionResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const provisionId = trimStr(body.provision_id)
  const qrUrl = trimStr(body.qr_url)
  if (!provisionId || !qrUrl) {
    return null
  }
  const intervalSec = Number(body.interval)
  const expiresSec = Number(body.expires_in)
  return {
    provisionId,
    qrUrl,
    intervalMs: Number.isFinite(intervalSec) && intervalSec > 0 ? Math.round(intervalSec * 1000) : 3000,
    expiresInMs: Number.isFinite(expiresSec) && expiresSec > 0 ? Math.round(expiresSec * 1000) : 300000
  }
}

// The poll statuses the cloud actually returns (desktop_feishu_provisioning.py:
// STATUS_PENDING/SUCCESS/DENIED/EXPIRED). Anything else is coerced to 'pending'
// (keep polling) so a new server-side status can't wedge the client.
const FEISHU_POLL_STATES = new Set(['pending', 'success', 'denied', 'expired'])

/**
 * Validate + normalize one provision status poll response
 * (GET .../feishu/provision/{id}). The v2 contract NEVER carries the credential
 * here — on 'success' the caller fetches it from GET .../feishu/credentials.
 * Unknown statuses degrade to 'pending'.
 *
 * @param {unknown} body parsed JSON
 * @returns {{ status: string, agentName: string }}
 */
function parseFeishuProvisionStatusResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'pending', agentName: '' }
  }
  const rawStatus = String(body.status || '').trim().toLowerCase()
  return {
    status: FEISHU_POLL_STATES.has(rawStatus) ? rawStatus : 'pending',
    agentName: trimStr(body.agent_name)
  }
}

/**
 * Validate + normalize the v2 credentials response
 * (GET .../feishu/credentials → { app_id, app_secret, domain, ... }). Returns
 * null when the body cannot yield an injectable credential (both app_id +
 * app_secret) so a malformed body can never half-enable the adapter. The
 * routing fields (allowed_users/home_channel) are passed through as-is when
 * present; they make the desktop bot answer its owner immediately (the QR
 * scanner's open_id seeds the gateway DM allowlist), matching the cloud. Field
 * names are the descriptor `from` keys (appId/allowedUsers/...); an older cloud
 * that predates them yields '' → simply not emitted into the spawn env.
 *
 * @param {unknown} body parsed JSON
 * @returns {null | { appId: string, appSecret: string, domain: string, allowedUsers: string, homeChannel: string }}
 */
function parseFeishuCredentialsV2Response(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const appId = trimStr(body.app_id)
  const appSecret = trimStr(body.app_secret)
  if (!appId || !appSecret) {
    return null
  }
  return {
    appId,
    appSecret,
    domain: normalizeFeishuDomain(body.domain),
    allowedUsers: trimStr(body.allowed_users),
    homeChannel: trimStr(body.home_channel)
  }
}

// ── WeChat (iLink) provisioning endpoint contract (hc-538, LIVE) ─────────────
// The cloud leg (hermes-cloud) registers an iLink bot scoped to the user's
// Desktop anchor via a QR device flow it drives server-side, and pins the bot
// token (Fernet-encrypted) to that anchor. The desktop is a thin consumer of
// four JWT-authed endpoints (app/routers/desktop.py), shaped identically to the
// feishu four:
//
//   POST   {API_BASE}/api/v1/desktop/weixin/provision            body {}
//     → { provision_id, qr_url, expires_in, interval }
//       (qr_url is the iLink SCAN LINK — render it as a QR locally;
//        429 = another flow in flight, 502 = iLink upstream failure)
//   GET    {API_BASE}/api/v1/desktop/weixin/provision/{provision_id}
//     → { status: 'pending'|'success'|'denied'|'expired', message?, agent_name? }
//       (NEVER carries the credential; 404 = flow unknown/lost → expired)
//   GET    {API_BASE}/api/v1/desktop/weixin/credentials
//     → { account_id, token, base_url, dm_policy?, allowed_users?, home_channel? }
//       (404 = not provisioned yet)
//   DELETE {API_BASE}/api/v1/desktop/weixin/entry
//     → { ok, account_id }   (404 = nothing bound)

/**
 * Resolve the hc-538 WeChat provisioning endpoint URLs for an apiBase, honoring
 * env overrides (HERMES_DESKTOP_IM_WEIXIN_PROVISION_URL / _CREDENTIALS_URL /
 * _ENTRY_URL). Every resolved URL still has to pass isAllowedFeishuProvisionUrl
 * at the call site (the same apex-nodes.com/loopback allowlist — the JWT + bot
 * token must never travel to a foreign host); the override is a retargeting aid,
 * not an allowlist escape.
 *
 * @param {string} apiBase
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ provisionUrl: string, credentialsUrl: string, entryUrl: string }}
 */
function resolveWeixinProvisionEndpoints(apiBase, env = process.env) {
  const base = trimTrailingSlash(apiBase)
  const provisionOverride = trimStr(env && env.HERMES_DESKTOP_IM_WEIXIN_PROVISION_URL)
  const credentialsOverride = trimStr(env && env.HERMES_DESKTOP_IM_WEIXIN_CREDENTIALS_URL)
  const entryOverride = trimStr(env && env.HERMES_DESKTOP_IM_WEIXIN_ENTRY_URL)
  return {
    provisionUrl: provisionOverride || `${base}${WEIXIN_PROVISION_PATH}`,
    credentialsUrl: credentialsOverride || `${base}${WEIXIN_PROVISION_CREDENTIALS_PATH}`,
    entryUrl: entryOverride || `${base}${WEIXIN_PROVISION_ENTRY_PATH}`
  }
}

/**
 * Validate + normalize the WeChat credentials response
 * (GET .../weixin/credentials → { account_id, token, base_url, ... }). Returns
 * null when the body cannot yield an injectable credential (both account_id +
 * token) so a malformed body can never half-enable the adapter. The routing
 * fields (dm_policy/allowed_users/home_channel) are passed through as-is when
 * present; they make the desktop bot answer its owner immediately, matching the
 * cloud. Field names are the descriptor `from` keys (accountId/token/...).
 *
 * @param {unknown} body parsed JSON
 * @returns {null | { accountId: string, token: string, baseUrl: string, dmPolicy: string, allowedUsers: string, homeChannel: string }}
 */
function parseWeixinCredentialsResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const accountId = trimStr(body.account_id)
  const token = trimStr(body.token)
  if (!accountId || !token) {
    return null
  }
  return {
    accountId,
    token,
    baseUrl: trimStr(body.base_url),
    dmPolicy: trimStr(body.dm_policy),
    allowedUsers: trimStr(body.allowed_users),
    homeChannel: trimStr(body.home_channel)
  }
}

// ── ~/.hermes/.env plaintext FEISHU_* cleanup (hc-417 P1) ────────────────────
// The runtime loads {HERMES_HOME}/.env with override=True
// (hermes_cli/env_loader.py::load_hermes_dotenv), so a leftover plaintext
// FEISHU_APP_ID/… in the user's .env silently BEATS the credential the desktop
// injects into the spawn env — the freshly-provisioned independent app would
// never take effect (or worse, mix .env's app_id with the injected secret).
// On a successful hc-417 binding, main.cjs strips every FEISHU_* assignment
// from the runtime home's .env (warning first) so spawn injection becomes the
// single Feishu credential source.

// Matches one dotenv assignment line for a FEISHU_* key, tolerating the same
// grammar python-dotenv accepts: optional leading whitespace, optional
// `export `, spaces around `=`. Comment lines never match (a leading `#`
// fails the key charset).
const FEISHU_ENV_LINE_RE = /^\s*(?:export\s+)?(FEISHU_[A-Za-z0-9_]*)\s*=/

/**
 * Remove every FEISHU_* assignment line from a .env text. Non-FEISHU lines
 * (including comments and blanks) are preserved byte-for-byte, so the rewrite
 * can never corrupt unrelated configuration. Pure — the caller owns file I/O
 * and the pre-removal warning log.
 *
 * @param {unknown} envText raw .env file content
 * @returns {{ text: string, removed: string[] }} the rewritten text + the
 *   removed key names (never values — safe to log)
 */
function stripFeishuEnvOverrides(envText) {
  const raw = typeof envText === 'string' ? envText : ''
  if (!raw) {
    return { text: raw, removed: [] }
  }

  const removed = []
  const kept = []
  for (const line of raw.split('\n')) {
    const match = FEISHU_ENV_LINE_RE.exec(line)
    if (match) {
      removed.push(match[1])
      continue
    }
    kept.push(line)
  }

  if (removed.length === 0) {
    return { text: raw, removed: [] }
  }
  return { text: kept.join('\n'), removed }
}

module.exports = {
  CHANNEL_ENV_DESCRIPTORS,
  DEFAULT_FEISHU_DOMAIN,
  FEISHU_PROVISION_CREDENTIALS_PATH,
  FEISHU_PROVISION_ENTRY_PATH,
  FEISHU_PROVISION_PATH,
  VALID_FEISHU_DOMAINS,
  WEIXIN_PROVISION_CREDENTIALS_PATH,
  WEIXIN_PROVISION_ENTRY_PATH,
  WEIXIN_PROVISION_PATH,
  buildImEntrySpawnEnv,
  feishuProvisionPollUrl,
  isAllowedFeishuProvisionUrl,
  isKnownChannel,
  normalizeFeishuDomain,
  normalizeStoredImEntry,
  parseFeishuCredentialsV2Response,
  parseFeishuProvisionResponse,
  parseFeishuProvisionStatusResponse,
  parseWeixinCredentialsResponse,
  resolveFeishuProvisionEndpoints,
  resolveWeixinProvisionEndpoints,
  secretFieldsFor,
  shapeBinding,
  stripFeishuEnvOverrides
}
