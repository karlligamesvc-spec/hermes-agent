/**
 * apex-daemon.cjs
 *
 * Pure, electron-free helpers for hc-533 "本机 Agent 调度" — the APEX Desktop
 * daemon leg of the A2A epic. A signed-in user's cloud分身 (hc-523) can dispatch
 * a task to one of the user's OWN local coding agents (Claude Code / Codex /
 * Cursor); this desktop daemon reverse-connects to the cloud, registers the
 * machine, heartbeats, polls the bridge queue for tasks addressed to this
 * device, drives the local agent via the hc-524 AcpHarness (out-of-process,
 * `agent/coding_agents/run_once.py`), and posts the result back.
 *
 * Kept standalone (no `require('electron')`) so every wire contract, parser and
 * the reconnect backoff is unit-tested with `node --test`, exactly like
 * apex-im-entry.cjs / apex-feishu.cjs. main.cjs requires these and wires them
 * into the electron-coupled parts: the encrypted token store (safeStorage, same
 * treatment as the managed relay key), the heartbeat / poll timers, the
 * venv-python spawn of the runner, and the settings-page IPC.
 *
 * ── Cloud contract (hermes-cloud PR #601, hc-523; fork #108 error-face align) ─
 * All calls target apex-nodes.com (allowlisted). Register uses the login JWT;
 * every later call uses the returned device bridge token ("abr-…").
 *
 *   POST {API_BASE}/api/v1/a2a/daemon/device/register     (Bearer JWT)
 *     body { device_id, name?, capabilities? }
 *     → 201 { device: {...}, token: "abr-…" }   (raw token shown ONCE; persist it)
 *   POST {API_BASE}/api/v1/a2a/daemon/device/heartbeat    (Bearer abr-token)
 *     body {} | { capabilities }
 *     → { device: { ..., online: true } }        (~30s cadence; 90s online window)
 *   POST {API_BASE}/api/v1/a2a/bridge/tasks/poll          (Bearer abr-token)
 *     → { task: null | { id, bridge_type: "desktop_daemon", payload, … } }
 *   POST {API_BASE}/api/v1/a2a/bridge/tasks/{id}/result   (Bearer abr-token)
 *     body { status: "done"|"failed", result: {...} }
 *
 * Task payload (task.payload), per #601:
 *   { kind: "local_agent_run", agent_family: "claude"|"codex"|"cursor",
 *     prompt, cwd?, target_device_id, source_agent_id }
 *
 * Security red-lines (hc-533 PD): the device token is a credential — it only
 * ever lives encrypted (safeStorage) or in memory, never in a plaintext file or
 * a log. The runner drives the agent with the machine's OWN credentials; those
 * never leave the machine. This module logs key names / statuses, never secrets.
 */

'use strict'

// The coding-agent families the daemon drives in v1 — mirrors
// agent/coding_agents/run_once.SUPPORTED_FAMILIES (the registry's first-wave
// launchable set). Anything else is rejected with a clear "not wired" failure,
// never a fabricated success.
const SUPPORTED_AGENT_FAMILIES = Object.freeze(['claude', 'codex', 'cursor'])

// The bridge_type the cloud tags desktop-daemon tasks with (hc-523). A task
// carrying any other bridge_type is not ours to run.
const DAEMON_BRIDGE_TYPE = 'desktop_daemon'
const LOCAL_AGENT_RUN_KIND = 'local_agent_run'

const DEVICE_ID_MAX = 128
const DEVICE_NAME_MAX = 64
const FALLBACK_DEVICE_NAME = 'APEX Desktop'

// ── Cloud endpoint contract ─────────────────────────────────────────────────
const DAEMON_REGISTER_PATH = '/api/v1/a2a/daemon/device/register'
const DAEMON_HEARTBEAT_PATH = '/api/v1/a2a/daemon/device/heartbeat'
const DAEMON_DEVICES_PATH = '/api/v1/a2a/daemon/devices'
const BRIDGE_POLL_PATH = '/api/v1/a2a/bridge/tasks/poll'
const BRIDGE_TASKS_PATH = '/api/v1/a2a/bridge/tasks'

// Hosts these calls (login JWT + device token) may reach — https on
// apex-nodes.com (or a subdomain), or loopback for local cloud development.
// A poisoned apiBase / env override must not be able to leak the token to a
// foreign host. Mirrors apex-im-entry.isAllowedFeishuProvisionUrl.
const ALLOWED_DAEMON_APEX_DOMAIN = 'apex-nodes.com'
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function trimStr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * True when a daemon URL is allowed to be called. Anything else — other hosts,
 * other protocols, unparseable strings — is refused so the JWT / device token
 * can never travel to a foreign host.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedDaemonUrl(url) {
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
  return hostname === ALLOWED_DAEMON_APEX_DOMAIN || hostname.endsWith(`.${ALLOWED_DAEMON_APEX_DOMAIN}`)
}

/**
 * Resolve the daemon endpoint URLs for an apiBase, honoring env overrides so a
 * staging build can pin exact absolute URLs. Every resolved URL still has to
 * pass isAllowedDaemonUrl at the call site — the override is a retargeting aid,
 * not an allowlist escape. The per-task result URL is composed separately
 * (bridgeResultUrl) because it needs the task id.
 *
 * @param {string} apiBase e.g. https://apex-nodes.com/api → https://apex-nodes.com
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ registerUrl: string, heartbeatUrl: string, pollUrl: string, devicesUrl: string }}
 */
function resolveDaemonEndpoints(apiBase, env = process.env) {
  const base = trimTrailingSlash(apiBase)
  const e = env || {}
  return {
    registerUrl: trimStr(e.HERMES_DESKTOP_DAEMON_REGISTER_URL) || `${base}${DAEMON_REGISTER_PATH}`,
    heartbeatUrl: trimStr(e.HERMES_DESKTOP_DAEMON_HEARTBEAT_URL) || `${base}${DAEMON_HEARTBEAT_PATH}`,
    pollUrl: trimStr(e.HERMES_DESKTOP_DAEMON_POLL_URL) || `${base}${BRIDGE_POLL_PATH}`,
    devicesUrl: trimStr(e.HERMES_DESKTOP_DAEMON_DEVICES_URL) || `${base}${DAEMON_DEVICES_PATH}`
  }
}

/**
 * Compose the per-task result URL: POST {base}/api/v1/a2a/bridge/tasks/{id}/result.
 * A base override (HERMES_DESKTOP_DAEMON_TASKS_URL) pins the collection URL.
 *
 * @param {string} apiBase
 * @param {string} taskId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function bridgeResultUrl(apiBase, taskId, env = process.env) {
  const base = trimStr((env || {}).HERMES_DESKTOP_DAEMON_TASKS_URL) || `${trimTrailingSlash(apiBase)}${BRIDGE_TASKS_PATH}`
  return `${trimTrailingSlash(base)}/${encodeURIComponent(String(taskId || ''))}/result`
}

// ── Machine identity ────────────────────────────────────────────────────────

/**
 * A human-readable default device name derived from the hostname (the machine's
 * `.local` suffix stripped), clamped, falling back to a generic label. The user
 * can override this in settings; this is only the first-run default.
 *
 * @param {unknown} hostname
 * @returns {string}
 */
function defaultDeviceName(hostname) {
  const raw = trimStr(hostname).replace(/\.local$/i, '').trim()
  if (!raw) {
    return FALLBACK_DEVICE_NAME
  }
  return raw.slice(0, DEVICE_NAME_MAX)
}

/**
 * Normalize a user-supplied device name: trim, clamp, and fall back to the
 * hostname default when blank so a device is never nameless.
 *
 * @param {unknown} raw
 * @param {unknown} [hostname]
 * @returns {string}
 */
function sanitizeDeviceName(raw, hostname) {
  const trimmed = trimStr(raw).slice(0, DEVICE_NAME_MAX).trim()
  return trimmed || defaultDeviceName(hostname)
}

/**
 * Normalize a stable machine id: trim + clamp to the server's ≤128 limit.
 * Returns '' for anything unusable so the caller mints a fresh id.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeDeviceId(raw) {
  return trimStr(raw).slice(0, DEVICE_ID_MAX)
}

/**
 * The register request body (POST .../device/register). `capabilities` is an
 * opaque hint the cloud stores; we advertise the source + the families this
 * client CAN drive (actual availability is resolved at run time by the runner,
 * which returns agent_not_available for a missing binary — we never overclaim a
 * result). Omits `name` when blank so the server keeps its own default.
 *
 * @param {{ deviceId: string, deviceName?: string }} args
 * @returns {{ device_id: string, name?: string, capabilities: object }}
 */
function buildRegisterBody({ deviceId, deviceName } = {}) {
  const body = {
    device_id: normalizeDeviceId(deviceId),
    capabilities: { source: 'apex-desktop-daemon', agent_families: [...SUPPORTED_AGENT_FAMILIES] }
  }
  const name = trimStr(deviceName)
  if (name) {
    body.name = name.slice(0, DEVICE_NAME_MAX)
  }
  return body
}

// ── Response parsers (validate + normalize; null on garbage) ─────────────────

/**
 * Validate the register response (201 { device: {...}, token: "abr-…" }). The
 * raw token is shown only once — the caller MUST persist it (encrypted).
 * Returns null when the body cannot yield a usable token so a malformed body is
 * treated as "not registered" rather than half-registering.
 *
 * @param {unknown} body
 * @returns {null | { token: string, serverId: string, deviceName: string }}
 */
function parseRegisterResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const token = trimStr(body.token)
  if (!token) {
    return null
  }
  const device = body.device && typeof body.device === 'object' ? body.device : {}
  return {
    token,
    serverId: trimStr(device.id),
    deviceName: trimStr(device.name)
  }
}

/**
 * Validate one heartbeat response ({ device: { ..., online: true } }). Derives
 * a boolean online flag; anything unparseable degrades to online:false so the
 * daemon treats an ambiguous beat as "not confirmed online".
 *
 * @param {unknown} body
 * @returns {{ online: boolean }}
 */
function parseHeartbeatResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { online: false }
  }
  const device = body.device && typeof body.device === 'object' ? body.device : body
  return { online: device.online === true }
}

/**
 * Extract the task (if any) from a poll response ({ task: null | {…} }). Returns
 * null for an empty queue OR a malformed body — either way "nothing to do".
 *
 * @param {unknown} body
 * @returns {null | Record<string, unknown>}
 */
function parsePollResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const task = body.task
  return task && typeof task === 'object' && !Array.isArray(task) ? task : null
}

/**
 * Validate a claimed task envelope: it must carry a string id and — defensively,
 * since the device token only yields our tasks — the desktop_daemon bridge_type
 * and an object payload. Returns null (skip) on anything malformed.
 *
 * @param {unknown} task
 * @returns {null | { taskId: string, payload: Record<string, unknown> }}
 */
function parseTaskEnvelope(task) {
  if (!task || typeof task !== 'object') {
    return null
  }
  const taskId = trimStr(task.id)
  if (!taskId) {
    return null
  }
  if (trimStr(task.bridge_type) !== DAEMON_BRIDGE_TYPE) {
    return null
  }
  const payload = task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload) ? task.payload : null
  if (!payload) {
    return null
  }
  return { taskId, payload }
}

/**
 * Validate + normalize a local_agent_run payload into the job the runner reads
 * on stdin. Enforces kind, a supported family, and a non-empty prompt. Returns
 * a discriminated result so the caller can post a clean `invalid_task` failure
 * (never spawn) for a rejected payload.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, job: { family: string, prompt: string, cwd?: string } }
 *   | { ok: false, reason: string }}
 */
function parseLocalAgentRunPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload not an object' }
  }
  if (trimStr(payload.kind) !== LOCAL_AGENT_RUN_KIND) {
    return { ok: false, reason: `unsupported kind ${trimStr(payload.kind) || '(none)'}` }
  }
  const family = trimStr(payload.agent_family)
  if (!family) {
    return { ok: false, reason: 'missing agent_family' }
  }
  if (!SUPPORTED_AGENT_FAMILIES.includes(family)) {
    return { ok: false, reason: `unsupported agent_family ${family}` }
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
  if (!prompt.trim()) {
    return { ok: false, reason: 'missing prompt' }
  }
  const job = { family, prompt }
  const cwd = trimStr(payload.cwd)
  if (cwd) {
    job.cwd = cwd
  }
  return { ok: true, job }
}

// ── Result body assembly (cloud submit contract) ─────────────────────────────

/**
 * Shape the runner's flat result (agent/coding_agents/run_once.py stdout) into
 * the cloud submit body { status, result }. Per #601:
 *   - permission gate hit → { status: 'failed',
 *       result: { permission_required: true, permission_summary } }
 *     (v1 surfaces it; the cloud asks the owner to approve on Desktop — never here)
 *   - failed             → { status: 'failed', result: { error, detail?, output? } }
 *   - done               → { status: 'done', result: { output } }
 * A null / unparseable runner result (crash, non-JSON stdout) becomes a
 * `runner_no_result` failure so the cloud always gets a terminal answer.
 *
 * @param {unknown} runnerResult
 * @returns {{ status: 'done'|'failed', result: Record<string, unknown> }}
 */
function buildResultSubmitBody(runnerResult) {
  if (!runnerResult || typeof runnerResult !== 'object' || Array.isArray(runnerResult)) {
    return { status: 'failed', result: { error: 'runner_no_result' } }
  }
  const output = typeof runnerResult.output === 'string' ? runnerResult.output : ''

  if (runnerResult.permission_required === true) {
    const result = { permission_required: true, permission_summary: trimStr(runnerResult.permission_summary) }
    if (output) {
      result.output = output
    }
    return { status: 'failed', result }
  }

  if (runnerResult.status === 'failed') {
    const result = { error: trimStr(runnerResult.error) || 'run_failed' }
    const detail = trimStr(runnerResult.detail)
    if (detail) {
      result.detail = detail
    }
    if (output) {
      result.output = output
    }
    return { status: 'failed', result }
  }

  const result = { output }
  const sessionId = trimStr(runnerResult.session_id)
  if (sessionId) {
    result.session_id = sessionId
  }
  return { status: 'done', result }
}

/**
 * A terminal failure body for a payload the daemon rejected BEFORE spawning
 * (bad kind / unsupported family / missing prompt). The reason is a stable,
 * non-sensitive string (the prompt is never echoed).
 *
 * @param {string} reason
 * @returns {{ status: 'failed', result: { error: string, detail: string } }}
 */
function buildInvalidTaskResult(reason) {
  return { status: 'failed', result: { error: 'invalid_task', detail: trimStr(reason) } }
}

// ── Reconnect backoff ────────────────────────────────────────────────────────

/**
 * Deterministic capped exponential backoff for reconnect attempts:
 * base * 2^attempt, clamped to cap. attempt 0 → base. Pure (no jitter) so the
 * schedule is unit-tested exactly; the caller may add jitter at the timer.
 *
 * @param {number} attempt 0-based consecutive-failure count
 * @param {{ baseMs?: number, capMs?: number }} [opts]
 * @returns {number} delay in ms
 */
function nextBackoffMs(attempt, { baseMs = 2000, capMs = 60000 } = {}) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  // Cap the exponent so 2**n cannot overflow before the min() clamps it.
  const exponent = Math.min(n, 30)
  return Math.min(capMs, baseMs * 2 ** exponent)
}

// ── Status derivation (what the settings UI shows) ───────────────────────────

const DAEMON_STATUS = Object.freeze({
  DORMANT: 'dormant',
  CONNECTING: 'connecting',
  ONLINE: 'online',
  OFFLINE: 'offline',
  ERROR: 'error'
})

/**
 * Derive the single status label the settings block shows, from the daemon's
 * internal flags. Precedence: disabled → dormant; a hard error (e.g. session
 * expired, keychain unavailable) → error; not yet registered → connecting;
 * registered + a confirmed recent heartbeat → online; registered but the last
 * beat/poll failed → offline (reconnecting).
 *
 * @param {{ enabled?: boolean, registered?: boolean, connected?: boolean, lastError?: string }} state
 * @returns {string} one of DAEMON_STATUS
 */
function deriveDaemonStatus(state = {}) {
  if (!state.enabled) {
    return DAEMON_STATUS.DORMANT
  }
  if (trimStr(state.lastError)) {
    return DAEMON_STATUS.ERROR
  }
  if (!state.registered) {
    return DAEMON_STATUS.CONNECTING
  }
  return state.connected ? DAEMON_STATUS.ONLINE : DAEMON_STATUS.OFFLINE
}

// ── Config normalization (non-secret view; token stored separately/encrypted) ─

/**
 * Validate + normalize the persisted apex-daemon.json (AFTER main.cjs has
 * handled the encrypted token separately). Garbage degrades to a dormant,
 * unregistered default so boot never throws over the cache.
 *
 * @param {unknown} raw parsed file content
 * @returns {{ enabled: boolean, deviceId: string, deviceName: string, serverId: string }}
 */
function normalizeStoredDaemon(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: obj.enabled === true,
    deviceId: normalizeDeviceId(obj.deviceId),
    deviceName: trimStr(obj.deviceName).slice(0, DEVICE_NAME_MAX),
    serverId: trimStr(obj.serverId)
  }
}

module.exports = {
  BRIDGE_POLL_PATH,
  BRIDGE_TASKS_PATH,
  DAEMON_BRIDGE_TYPE,
  DAEMON_HEARTBEAT_PATH,
  DAEMON_REGISTER_PATH,
  DAEMON_STATUS,
  DEVICE_ID_MAX,
  LOCAL_AGENT_RUN_KIND,
  SUPPORTED_AGENT_FAMILIES,
  bridgeResultUrl,
  buildInvalidTaskResult,
  buildRegisterBody,
  buildResultSubmitBody,
  defaultDeviceName,
  deriveDaemonStatus,
  isAllowedDaemonUrl,
  nextBackoffMs,
  normalizeDeviceId,
  normalizeStoredDaemon,
  parseHeartbeatResponse,
  parseLocalAgentRunPayload,
  parsePollResponse,
  parseRegisterResponse,
  parseTaskEnvelope,
  resolveDaemonEndpoints,
  sanitizeDeviceName
}
