/**
 * Tests for electron/apex-daemon.cjs (hc-533 本机 Agent 调度 daemon leg).
 *
 * Run with: node --test electron/apex-daemon.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * The pure wire contract + reconnect logic behind the daemon: the host
 * allowlist that keeps the JWT / device token on apex-nodes.com, endpoint +
 * result-URL resolution, the register/heartbeat/poll/task/payload parsers, the
 * cloud submit-body shaping (incl. the permission-gate surface that v1 never
 * auto-approves), the capped exponential reconnect backoff, and the settings
 * status derivation. The encrypted token store, timers and venv-python spawn
 * live in main.cjs; here we prove the shaping/gating/backoff logic.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DAEMON_BRIDGE_TYPE,
  DAEMON_HEARTBEAT_PATH,
  DAEMON_REGISTER_PATH,
  DAEMON_STATUS,
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
} = require('./apex-daemon.cjs')

// ── Host allowlist (JWT + device token must not leak off-host) ───────────────

test('isAllowedDaemonUrl allows apex-nodes.com https + subdomains + loopback', () => {
  for (const url of [
    'https://apex-nodes.com/api/v1/a2a/daemon/device/register',
    'https://api.apex-nodes.com/api/v1/a2a/daemon/device/heartbeat',
    'http://localhost:8000/api/v1/a2a/bridge/tasks/poll',
    'https://127.0.0.1:8000/x',
    'http://127.0.0.1/x'
  ]) {
    assert.equal(isAllowedDaemonUrl(url), true, url)
  }
})

test('isAllowedDaemonUrl refuses http-apex, foreign hosts, bad protocols, garbage', () => {
  for (const url of [
    'http://apex-nodes.com/x', // plain http off loopback
    'https://evil.com/x',
    'https://apex-nodes.com.evil.com/x', // suffix-spoof
    'ftp://apex-nodes.com/x',
    'file:///etc/passwd',
    'not a url',
    '',
    null,
    undefined
  ]) {
    assert.equal(isAllowedDaemonUrl(url), false, String(url))
  }
})

// ── Endpoint + result-URL resolution ────────────────────────────────────────

test('resolveDaemonEndpoints composes paths off apiBase and strips trailing slash', () => {
  const eps = resolveDaemonEndpoints('https://apex-nodes.com/', {})
  assert.equal(eps.registerUrl, `https://apex-nodes.com${DAEMON_REGISTER_PATH}`)
  assert.equal(eps.heartbeatUrl, `https://apex-nodes.com${DAEMON_HEARTBEAT_PATH}`)
  assert.equal(eps.pollUrl, 'https://apex-nodes.com/api/v1/a2a/bridge/tasks/poll')
})

test('resolveDaemonEndpoints honors env overrides', () => {
  const eps = resolveDaemonEndpoints('https://apex-nodes.com', {
    HERMES_DESKTOP_DAEMON_REGISTER_URL: 'http://localhost:8000/reg'
  })
  assert.equal(eps.registerUrl, 'http://localhost:8000/reg')
  // unrelated endpoints still composed off the base
  assert.equal(eps.heartbeatUrl, `https://apex-nodes.com${DAEMON_HEARTBEAT_PATH}`)
})

test('bridgeResultUrl composes /tasks/{id}/result and encodes the id', () => {
  assert.equal(
    bridgeResultUrl('https://apex-nodes.com', 'abc-123', {}),
    'https://apex-nodes.com/api/v1/a2a/bridge/tasks/abc-123/result'
  )
  assert.equal(
    bridgeResultUrl('https://apex-nodes.com', 'a/b', {}),
    'https://apex-nodes.com/api/v1/a2a/bridge/tasks/a%2Fb/result'
  )
})

// ── Machine identity ─────────────────────────────────────────────────────────

test('defaultDeviceName strips .local, clamps, and falls back', () => {
  assert.equal(defaultDeviceName('Karls-MacBook.local'), 'Karls-MacBook')
  assert.equal(defaultDeviceName('  '), 'APEX Desktop')
  assert.equal(defaultDeviceName(null), 'APEX Desktop')
  assert.equal(defaultDeviceName('x'.repeat(200)).length, 64)
})

test('sanitizeDeviceName trims/clamps and falls back to hostname default', () => {
  assert.equal(sanitizeDeviceName('  My Mac  ', 'host.local'), 'My Mac')
  assert.equal(sanitizeDeviceName('', 'host.local'), 'host')
  assert.equal(sanitizeDeviceName('  ', 'weird.local'), 'weird')
})

test('normalizeDeviceId trims and clamps to 128', () => {
  assert.equal(normalizeDeviceId('  dev-1  '), 'dev-1')
  assert.equal(normalizeDeviceId('x'.repeat(200)).length, 128)
  assert.equal(normalizeDeviceId(42), '')
})

test('buildRegisterBody carries device_id + capabilities, omits blank name', () => {
  const withName = buildRegisterBody({ deviceId: 'dev-1', deviceName: 'My Mac' })
  assert.equal(withName.device_id, 'dev-1')
  assert.equal(withName.name, 'My Mac')
  assert.deepEqual(withName.capabilities.agent_families, [...SUPPORTED_AGENT_FAMILIES])
  assert.equal(withName.capabilities.source, 'apex-desktop-daemon')

  const noName = buildRegisterBody({ deviceId: 'dev-2', deviceName: '  ' })
  assert.equal('name' in noName, false)
})

// ── Response parsers ─────────────────────────────────────────────────────────

test('parseRegisterResponse extracts token + server device fields', () => {
  const parsed = parseRegisterResponse({ token: 'abr-xyz', device: { id: 'srv-1', name: 'My Mac' } })
  assert.deepEqual(parsed, { token: 'abr-xyz', serverId: 'srv-1', deviceName: 'My Mac' })
})

test('parseRegisterResponse returns null without a token', () => {
  assert.equal(parseRegisterResponse({ device: { id: 'srv-1' } }), null)
  assert.equal(parseRegisterResponse(null), null)
  assert.equal(parseRegisterResponse('nope'), null)
})

test('parseHeartbeatResponse derives online only from an explicit true', () => {
  assert.deepEqual(parseHeartbeatResponse({ device: { online: true } }), { online: true })
  assert.deepEqual(parseHeartbeatResponse({ device: { online: false } }), { online: false })
  assert.deepEqual(parseHeartbeatResponse({ online: true }), { online: true }) // device omitted
  assert.deepEqual(parseHeartbeatResponse('garbage'), { online: false })
})

test('parsePollResponse yields the task object or null', () => {
  const task = { id: 't1', bridge_type: DAEMON_BRIDGE_TYPE, payload: {} }
  assert.equal(parsePollResponse({ task }), task)
  assert.equal(parsePollResponse({ task: null }), null)
  assert.equal(parsePollResponse({}), null)
  assert.equal(parsePollResponse('nope'), null)
})

test('parseTaskEnvelope requires id, desktop_daemon bridge_type, object payload', () => {
  assert.deepEqual(
    parseTaskEnvelope({ id: 't1', bridge_type: DAEMON_BRIDGE_TYPE, payload: { kind: 'x' } }),
    { taskId: 't1', payload: { kind: 'x' } }
  )
  assert.equal(parseTaskEnvelope({ bridge_type: DAEMON_BRIDGE_TYPE, payload: {} }), null) // no id
  assert.equal(parseTaskEnvelope({ id: 't1', bridge_type: 'workbuddy', payload: {} }), null) // not ours
  assert.equal(parseTaskEnvelope({ id: 't1', bridge_type: DAEMON_BRIDGE_TYPE }), null) // no payload
  assert.equal(parseTaskEnvelope(null), null)
})

// ── Payload validation gate ──────────────────────────────────────────────────

test('parseLocalAgentRunPayload accepts a well-formed job (cwd optional)', () => {
  assert.deepEqual(
    parseLocalAgentRunPayload({
      kind: 'local_agent_run',
      agent_family: 'claude',
      prompt: 'fix the bug',
      cwd: '/repo',
      target_device_id: 'srv-1'
    }),
    { ok: true, job: { family: 'claude', prompt: 'fix the bug', cwd: '/repo' } }
  )
  const noCwd = parseLocalAgentRunPayload({ kind: 'local_agent_run', agent_family: 'codex', prompt: 'go' })
  assert.deepEqual(noCwd, { ok: true, job: { family: 'codex', prompt: 'go' } })
})

test('parseLocalAgentRunPayload rejects bad kind / family / prompt with a reason', () => {
  const cases = [
    [{ kind: 'other', agent_family: 'claude', prompt: 'x' }, 'unsupported kind'],
    [{ kind: 'local_agent_run', agent_family: 'codebuddy', prompt: 'x' }, 'unsupported agent_family'],
    [{ kind: 'local_agent_run', agent_family: 'claude', prompt: '   ' }, 'missing prompt'],
    [{ kind: 'local_agent_run', prompt: 'x' }, 'missing agent_family'],
    ['nope', 'payload not an object']
  ]
  for (const [payload, fragment] of cases) {
    const out = parseLocalAgentRunPayload(payload)
    assert.equal(out.ok, false)
    assert.ok(out.reason.includes(fragment), `${out.reason} ~ ${fragment}`)
  }
})

// ── Result submit-body shaping ───────────────────────────────────────────────

test('buildResultSubmitBody: done carries output (+ session id)', () => {
  assert.deepEqual(
    buildResultSubmitBody({ status: 'done', output: 'All fixed', session_id: 'claude-1' }),
    { status: 'done', result: { output: 'All fixed', session_id: 'claude-1' } }
  )
})

test('buildResultSubmitBody: permission gate → failed + permission_required, never approves', () => {
  const body = buildResultSubmitBody({
    status: 'failed',
    permission_required: true,
    permission_summary: 'rm -rf build/',
    output: 'about to delete'
  })
  assert.equal(body.status, 'failed')
  assert.equal(body.result.permission_required, true)
  assert.equal(body.result.permission_summary, 'rm -rf build/')
  // No approval field is ever emitted by the daemon.
  assert.equal('approved' in body.result, false)
})

test('buildResultSubmitBody: failed carries error + detail', () => {
  assert.deepEqual(
    buildResultSubmitBody({ status: 'failed', error: 'agent_not_available', detail: "'claude' not found" }),
    { status: 'failed', result: { error: 'agent_not_available', detail: "'claude' not found" } }
  )
})

test('buildResultSubmitBody: null / garbage runner result → runner_no_result', () => {
  assert.deepEqual(buildResultSubmitBody(null), { status: 'failed', result: { error: 'runner_no_result' } })
  assert.deepEqual(buildResultSubmitBody('boom'), { status: 'failed', result: { error: 'runner_no_result' } })
})

test('buildInvalidTaskResult is a terminal invalid_task failure', () => {
  assert.deepEqual(buildInvalidTaskResult('unsupported agent_family x'), {
    status: 'failed',
    result: { error: 'invalid_task', detail: 'unsupported agent_family x' }
  })
})

// ── Reconnect backoff ────────────────────────────────────────────────────────

test('nextBackoffMs is capped exponential from base', () => {
  assert.equal(nextBackoffMs(0, { baseMs: 2000, capMs: 60000 }), 2000)
  assert.equal(nextBackoffMs(1, { baseMs: 2000, capMs: 60000 }), 4000)
  assert.equal(nextBackoffMs(2, { baseMs: 2000, capMs: 60000 }), 8000)
  assert.equal(nextBackoffMs(5, { baseMs: 2000, capMs: 60000 }), 60000) // 64000 → capped
  assert.equal(nextBackoffMs(1000, { baseMs: 2000, capMs: 60000 }), 60000) // no overflow
  assert.equal(nextBackoffMs(-3, { baseMs: 2000, capMs: 60000 }), 2000) // negative → base
})

// ── Status derivation ────────────────────────────────────────────────────────

test('deriveDaemonStatus maps flags to the settings label', () => {
  assert.equal(deriveDaemonStatus({ enabled: false }), DAEMON_STATUS.DORMANT)
  assert.equal(deriveDaemonStatus({ enabled: true, lastError: 'SESSION_EXPIRED' }), DAEMON_STATUS.ERROR)
  assert.equal(deriveDaemonStatus({ enabled: true, registered: false }), DAEMON_STATUS.CONNECTING)
  assert.equal(deriveDaemonStatus({ enabled: true, registered: true, connected: true }), DAEMON_STATUS.ONLINE)
  assert.equal(deriveDaemonStatus({ enabled: true, registered: true, connected: false }), DAEMON_STATUS.OFFLINE)
})

// ── Stored-config normalization ──────────────────────────────────────────────

test('normalizeStoredDaemon degrades garbage to a dormant default', () => {
  assert.deepEqual(normalizeStoredDaemon(null), {
    enabled: false,
    deviceId: '',
    deviceName: '',
    serverId: ''
  })
  assert.deepEqual(
    normalizeStoredDaemon({ enabled: true, deviceId: 'dev-1', deviceName: 'My Mac', serverId: 'srv-1', junk: 1 }),
    { enabled: true, deviceId: 'dev-1', deviceName: 'My Mac', serverId: 'srv-1' }
  )
})
