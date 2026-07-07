/**
 * Tests for electron/apex-feishu.cjs (hc-444 desktop ↔ cloud Feishu bridge).
 *
 * Run with: node --test electron/apex-feishu.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * These are the pure helpers behind the bridge: URL building, response parsing +
 * the has_entry/both-halves gate, stored-state normalization, the injection gate,
 * and the backend-env fragment builder. Secret handling (safeStorage) lives in
 * main.cjs and is exercised there; here we prove the pure shaping/gating logic.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_FEISHU_DOMAIN,
  FEISHU_CREDENTIALS_PATH,
  buildFeishuBackendEnv,
  feishuCredentialsUrl,
  normalizeFeishuDomain,
  normalizeStoredFeishu,
  parseFeishuCredentialsResponse,
  shouldInjectFeishu
} = require('./apex-feishu.cjs')

test('feishuCredentialsUrl appends the desktop route and trims a trailing slash', () => {
  assert.equal(
    feishuCredentialsUrl('https://api.apex-nodes.com'),
    `https://api.apex-nodes.com${FEISHU_CREDENTIALS_PATH}`
  )
  assert.equal(
    feishuCredentialsUrl('https://api.apex-nodes.com/'),
    `https://api.apex-nodes.com${FEISHU_CREDENTIALS_PATH}`
  )
})

test('normalizeFeishuDomain accepts feishu/lark case-insensitively, defaults otherwise', () => {
  assert.equal(normalizeFeishuDomain('feishu'), 'feishu')
  assert.equal(normalizeFeishuDomain('LARK'), 'lark')
  assert.equal(normalizeFeishuDomain(' Lark '), 'lark')
  assert.equal(normalizeFeishuDomain('bogus'), DEFAULT_FEISHU_DOMAIN)
  assert.equal(normalizeFeishuDomain(''), DEFAULT_FEISHU_DOMAIN)
  assert.equal(normalizeFeishuDomain(null), DEFAULT_FEISHU_DOMAIN)
  assert.equal(normalizeFeishuDomain(undefined), DEFAULT_FEISHU_DOMAIN)
})

test('parseFeishuCredentialsResponse returns a full credential when bound', () => {
  const parsed = parseFeishuCredentialsResponse({
    has_entry: true,
    app_id: 'cli_abc',
    app_secret: 'shhh',
    domain: 'lark',
    agent_name: '我的飞书助手',
    credential_status: 'ok'
  })
  assert.deepEqual(parsed, {
    hasEntry: true,
    appId: 'cli_abc',
    appSecret: 'shhh',
    domain: 'lark',
    agentName: '我的飞书助手',
    credentialStatus: 'ok'
  })
})

test('parseFeishuCredentialsResponse reports no entry when has_entry is false', () => {
  const parsed = parseFeishuCredentialsResponse({ has_entry: false })
  assert.equal(parsed.hasEntry, false)
  assert.equal(parsed.appId, '')
  assert.equal(parsed.appSecret, '')
  assert.equal(parsed.domain, DEFAULT_FEISHU_DOMAIN)
})

test('parseFeishuCredentialsResponse never advertises a half credential', () => {
  // Server claims an entry but omits the secret → not usable → hasEntry:false.
  const missingSecret = parseFeishuCredentialsResponse({ has_entry: true, app_id: 'cli_abc' })
  assert.equal(missingSecret.hasEntry, false)
  assert.equal(missingSecret.appSecret, '')

  const missingId = parseFeishuCredentialsResponse({ has_entry: true, app_secret: 'shhh' })
  assert.equal(missingId.hasEntry, false)
  assert.equal(missingId.appId, '')
})

test('parseFeishuCredentialsResponse preserves credential_status even with no entry', () => {
  const parsed = parseFeishuCredentialsResponse({ has_entry: false, credential_status: 'expired' })
  assert.equal(parsed.hasEntry, false)
  assert.equal(parsed.credentialStatus, 'expired')
})

test('parseFeishuCredentialsResponse fails soft on garbage', () => {
  assert.equal(parseFeishuCredentialsResponse(null), null)
  assert.equal(parseFeishuCredentialsResponse('nope'), null)
  assert.equal(parseFeishuCredentialsResponse([1, 2, 3]), null)
  assert.equal(parseFeishuCredentialsResponse(42), null)
})

test('normalizeStoredFeishu round-trips a connected record', () => {
  const stored = normalizeStoredFeishu({
    appId: 'cli_abc',
    appSecret: 'shhh',
    domain: 'lark',
    agentName: '助手',
    credentialStatus: 'ok',
    syncedAt: 1720000000000
  })
  assert.equal(stored.connected, true)
  assert.equal(stored.appId, 'cli_abc')
  assert.equal(stored.appSecret, 'shhh')
  assert.equal(stored.domain, 'lark')
  assert.equal(stored.agentName, '助手')
  assert.equal(stored.syncedAt, 1720000000000)
})

test('normalizeStoredFeishu degrades a partial record (lost secret) to not-connected', () => {
  const stored = normalizeStoredFeishu({ appId: 'cli_abc', appSecret: '' })
  assert.equal(stored.connected, false)
  assert.equal(stored.appId, '')
  assert.equal(stored.appSecret, '')
  assert.equal(stored.domain, DEFAULT_FEISHU_DOMAIN)
})

test('normalizeStoredFeishu degrades garbage to the empty state', () => {
  for (const bad of [null, undefined, 'x', 7, []]) {
    const stored = normalizeStoredFeishu(bad)
    assert.equal(stored.connected, false)
    assert.equal(stored.appSecret, '')
    assert.equal(stored.syncedAt, null)
  }
})

test('shouldInjectFeishu gates on BOTH halves present', () => {
  assert.equal(shouldInjectFeishu({ appId: 'a', appSecret: 'b' }), true)
  assert.equal(shouldInjectFeishu({ appId: 'a', appSecret: '' }), false)
  assert.equal(shouldInjectFeishu({ appId: '', appSecret: 'b' }), false)
  assert.equal(shouldInjectFeishu({ appId: '  ', appSecret: 'b' }), false)
  assert.equal(shouldInjectFeishu(null), false)
  assert.equal(shouldInjectFeishu(undefined), false)
})

test('buildFeishuBackendEnv emits exactly the three runtime env vars when injectable', () => {
  const env = buildFeishuBackendEnv({ appId: 'cli_abc', appSecret: 'shhh', domain: 'lark' })
  assert.deepEqual(env, {
    FEISHU_APP_ID: 'cli_abc',
    FEISHU_APP_SECRET: 'shhh',
    FEISHU_DOMAIN: 'lark'
  })
})

test('buildFeishuBackendEnv defaults the domain and trims values', () => {
  const env = buildFeishuBackendEnv({ appId: ' cli_abc ', appSecret: ' shhh ', domain: 'weird' })
  assert.equal(env.FEISHU_APP_ID, 'cli_abc')
  assert.equal(env.FEISHU_APP_SECRET, 'shhh')
  assert.equal(env.FEISHU_DOMAIN, DEFAULT_FEISHU_DOMAIN)
})

test('buildFeishuBackendEnv is an empty no-op fragment when not injectable', () => {
  // A not-connected user must never contribute FEISHU_* keys to the spawn env,
  // so a `{ ...env, ...buildFeishuBackendEnv(cred) }` merge changes nothing.
  assert.deepEqual(buildFeishuBackendEnv(null), {})
  assert.deepEqual(buildFeishuBackendEnv({ appId: 'a', appSecret: '' }), {})
  assert.deepEqual(buildFeishuBackendEnv({}), {})
})
