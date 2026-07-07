/**
 * apex-feishu.cjs
 *
 * Pure, electron-free helpers for the hc-444 "desktop ↔ cloud Feishu bridge".
 * Kept standalone (no `require('electron')`) so it can be unit-tested with
 * `node --test`, same pattern as apex-managed.cjs / apex-client-config.cjs.
 * main.cjs requires these and wires them into the electron-coupled IPC, the
 * encrypted persistence (safeStorage, like apex-managed.json) and the backend
 * spawn env.
 *
 * ── Why a bridge at all ─────────────────────────────────────────────────────
 * The cloud Feishu line is already complete and used by real users: each user
 * self-registers their own Feishu app via the QR device-flow, the app
 * credentials live in the cloud (`agent_entries`, entry_type='feishu_app'), a
 * shared webhook ingests events routed by app_id, and a probe tracks credential
 * health. The ONLY missing hop is the desktop: a locally-run agent runtime needs
 * the user's own FEISHU_APP_ID / FEISHU_APP_SECRET in its environment to light up
 * the Feishu adapter + the lark doc/drive tools (the runtime gates the adapter on
 * the mere PRESENCE of both env vars — see gateway/config.py).
 *
 * ── Backend contract (hc-444) ───────────────────────────────────────────────
 *   GET {API_BASE}/api/v1/desktop/feishu-credentials
 *   Authorization: Bearer <login JWT>
 *   200 → { has_entry: bool, app_id?, app_secret?, domain?, agent_name?,
 *           credential_status? }
 *
 * The endpoint is JWT-authed (only the owner can fetch), TLS-only, and
 * audit-logged with the secret redacted. This module returns the credential to
 * main.cjs, which persists it ENCRYPTED (Electron safeStorage — same treatment
 * as the managed relay key) and injects it JUST-IN-TIME into the backend spawn
 * env. The secret is never written to a plaintext `.env` and never logged.
 *
 * ── Not this module's job ───────────────────────────────────────────────────
 * ISV / a rebuilt binding wizard / adapter kernel changes are explicitly out of
 * scope (hc-445 ruled ISV out). A user with NO cloud Feishu entry is guided into
 * the existing cloud web binding flow (opened in the system browser); this module
 * only knows how to fetch, validate, gate and shape the credential for injection.
 */

// The desktop credential-fetch route lives on API_BASE (same host as
// provision-key), under the desktop router.
const FEISHU_CREDENTIALS_PATH = '/api/v1/desktop/feishu-credentials'

// Feishu (China) vs Lark (International) — the only two values the runtime's
// FEISHU_DOMAIN accepts; "feishu" is the runtime's own default.
const VALID_FEISHU_DOMAINS = new Set(['feishu', 'lark'])
const DEFAULT_FEISHU_DOMAIN = 'feishu'

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Build the credential-fetch URL for an apiBase.
 *
 * @param {string} apiBase e.g. https://api.apex-nodes.com
 * @returns {string}
 */
function feishuCredentialsUrl(apiBase) {
  return `${trimTrailingSlash(apiBase)}${FEISHU_CREDENTIALS_PATH}`
}

/**
 * Normalize a Feishu domain to one the runtime accepts. Anything unknown/absent
 * degrades to the runtime's own default ("feishu") so a garbage value can never
 * point the adapter at a nonexistent host.
 *
 * @param {unknown} value
 * @returns {'feishu' | 'lark'}
 */
function normalizeFeishuDomain(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase()
  return VALID_FEISHU_DOMAINS.has(raw) ? raw : DEFAULT_FEISHU_DOMAIN
}

/**
 * Validate + normalize the GET /desktop/feishu-credentials response body into the
 * shape the desktop persists/applies. Returns null on garbage so a malformed body
 * is treated exactly like "no credential" (fail-soft — never throws into boot /
 * sync). A body with `has_entry:false` (or missing app_id/app_secret) resolves to
 * `{ hasEntry: false }` with empty secret fields.
 *
 * @param {unknown} body parsed JSON response
 * @returns {null | {
 *   hasEntry: boolean, appId: string, appSecret: string, domain: string,
 *   agentName: string, credentialStatus: string
 * }}
 */
function parseFeishuCredentialsResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null

  const str = value => (typeof value === 'string' ? value.trim() : '')
  const appId = str(body.app_id)
  const appSecret = str(body.app_secret)
  // A credential is only usable when BOTH halves are present. Trust the
  // server's has_entry flag, but never advertise a credential we can't actually
  // inject (both fields non-empty) — the two must agree for `hasEntry:true`.
  const hasEntry = body.has_entry === true && Boolean(appId) && Boolean(appSecret)

  if (!hasEntry) {
    return {
      hasEntry: false,
      appId: '',
      appSecret: '',
      domain: DEFAULT_FEISHU_DOMAIN,
      agentName: '',
      credentialStatus: str(body.credential_status)
    }
  }

  return {
    hasEntry: true,
    appId,
    appSecret,
    domain: normalizeFeishuDomain(body.domain),
    agentName: str(body.agent_name),
    credentialStatus: str(body.credential_status)
  }
}

/**
 * Normalize the persisted apex-feishu.json content (AFTER main.cjs has decrypted
 * the app_secret). Any garbage (missing file, corrupt JSON, tampered fields)
 * degrades to the empty state so boot can never throw over the cache and a
 * partial record (secret lost) is treated as "not connected".
 *
 * @param {unknown} raw parsed file content with the secret already decrypted
 * @returns {{
 *   connected: boolean, appId: string, appSecret: string, domain: string,
 *   agentName: string, credentialStatus: string, syncedAt: number | null
 * }}
 */
function normalizeStoredFeishu(raw) {
  const empty = {
    connected: false,
    appId: '',
    appSecret: '',
    domain: DEFAULT_FEISHU_DOMAIN,
    agentName: '',
    credentialStatus: '',
    syncedAt: null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty

  const str = value => (typeof value === 'string' ? value.trim() : '')
  const appId = str(raw.appId)
  const appSecret = str(raw.appSecret)
  // Both halves are required to be "connected"; a record missing either (e.g. a
  // decrypt failure blanked the secret) is unusable → empty.
  if (!appId || !appSecret) return empty

  const syncedAt = typeof raw.syncedAt === 'number' && Number.isFinite(raw.syncedAt) ? raw.syncedAt : null
  return {
    connected: true,
    appId,
    appSecret,
    domain: normalizeFeishuDomain(raw.domain),
    agentName: str(raw.agentName),
    credentialStatus: str(raw.credentialStatus),
    syncedAt
  }
}

/**
 * Gate: should this credential be injected into the backend spawn env? True only
 * when BOTH app_id and app_secret are non-empty — the exact condition the runtime
 * uses to enable the Feishu adapter (presence of both FEISHU_APP_ID +
 * FEISHU_APP_SECRET). Centralized so every call site agrees.
 *
 * @param {{ appId?: string, appSecret?: string } | null | undefined} cred
 * @returns {boolean}
 */
function shouldInjectFeishu(cred) {
  return Boolean(cred && String(cred.appId || '').trim() && String(cred.appSecret || '').trim())
}

/**
 * Build the backend spawn env fragment that lights up the Feishu adapter + lark
 * tools. Returns an EMPTY object (no keys) when the credential isn't injectable,
 * so a `{ ...backendEnv, ...buildFeishuBackendEnv(cred) }` merge is a safe no-op
 * for a not-connected user (it never clobbers an env the parent set).
 *
 * The runtime reads FEISHU_APP_ID / FEISHU_APP_SECRET directly (os.getenv) and
 * gates the adapter on their presence; FEISHU_DOMAIN selects feishu vs lark. We
 * emit exactly these three — nothing else — so injection is minimal and reversible
 * (a sign-out simply stops emitting them on the next spawn).
 *
 * @param {{ appId?: string, appSecret?: string, domain?: string } | null | undefined} cred
 * @returns {Record<string, string>}
 */
function buildFeishuBackendEnv(cred) {
  if (!shouldInjectFeishu(cred)) return {}
  return {
    FEISHU_APP_ID: String(cred.appId).trim(),
    FEISHU_APP_SECRET: String(cred.appSecret).trim(),
    FEISHU_DOMAIN: normalizeFeishuDomain(cred.domain)
  }
}

module.exports = {
  DEFAULT_FEISHU_DOMAIN,
  FEISHU_CREDENTIALS_PATH,
  VALID_FEISHU_DOMAINS,
  buildFeishuBackendEnv,
  feishuCredentialsUrl,
  normalizeFeishuDomain,
  normalizeStoredFeishu,
  parseFeishuCredentialsResponse,
  shouldInjectFeishu
}
