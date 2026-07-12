/**
 * Tests for electron/apex-im-entry.cjs (hc-417 Desktop IM 入口 config pipeline).
 *
 * Run with: node --test electron/apex-im-entry.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * These are the pure helpers behind the pipeline: the channel env descriptors,
 * binding shaping + the required-field gate, stored-state normalization, the
 * spawn-env fragment builder (add-only, descriptor-keyed), the secret-field
 * classification the encrypt layer reads, the device-code endpoint resolution +
 * its env overrides, and the init/poll response parsers. Secret handling
 * (safeStorage) + IPC live in main.cjs; here we prove the shaping/gating logic.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FEISHU_ISSUE_PATH,
  FEISHU_POLL_PATH,
  buildImEntrySpawnEnv,
  isKnownChannel,
  normalizeFeishuDomain,
  normalizeStoredImEntry,
  parseFeishuIssueResponse,
  parseFeishuPollResponse,
  resolveFeishuIssueEndpoints,
  secretFieldsFor,
  shapeBinding
} = require('./apex-im-entry.cjs')

test('isKnownChannel accepts feishu and rejects unknown / non-string ids', () => {
  assert.equal(isKnownChannel('feishu'), true)
  assert.equal(isKnownChannel('weixin'), false) // coming-soon, not injectable yet
  assert.equal(isKnownChannel('__proto__'), false)
  assert.equal(isKnownChannel(null), false)
  assert.equal(isKnownChannel(42), false)
})

test('shapeBinding requires both app id + secret, normalizes domain, stamps boundAt', () => {
  const shaped = shapeBinding('feishu', {
    appId: '  cli_abc  ',
    appSecret: ' s3cret ',
    domain: 'LARK'
  })
  assert.ok(shaped)
  assert.equal(shaped.channelId, 'feishu')
  assert.deepEqual(shaped.fields, { appId: 'cli_abc', appSecret: 's3cret', domain: 'lark' })
  assert.equal(typeof shaped.boundAt, 'number')

  // A garbage domain degrades to the runtime default rather than being emitted raw.
  assert.equal(shapeBinding('feishu', { appId: 'a', appSecret: 'b', domain: 'nope' }).fields.domain, 'feishu')
  // Domain omitted → not emitted (the runtime defaults it), no key at all.
  assert.equal('domain' in shapeBinding('feishu', { appId: 'a', appSecret: 'b' }).fields, false)
})

test('shapeBinding returns null for missing required fields or unknown channel', () => {
  assert.equal(shapeBinding('feishu', { appId: 'only-id' }), null)
  assert.equal(shapeBinding('feishu', { appSecret: 'only-secret' }), null)
  assert.equal(shapeBinding('feishu', {}), null)
  assert.equal(shapeBinding('feishu', null), null)
  assert.equal(shapeBinding('weixin', { appId: 'a', appSecret: 'b' }), null)
})

test('shapeBinding preserves an existing boundAt on re-shape', () => {
  const shaped = shapeBinding('feishu', { appId: 'a', appSecret: 'b' }, { boundAt: 111 })
  assert.equal(shaped.boundAt, 111)
})

test('secretFieldsFor reports only the secret-valued fields', () => {
  assert.deepEqual(secretFieldsFor('feishu'), ['appSecret'])
  assert.deepEqual(secretFieldsFor('weixin'), [])
})

test('normalizeStoredImEntry drops garbage, unknown channels + partial records', () => {
  assert.deepEqual(normalizeStoredImEntry(null), {})
  assert.deepEqual(normalizeStoredImEntry({}), {})
  assert.deepEqual(normalizeStoredImEntry({ bindings: 'nope' }), {})

  const store = normalizeStoredImEntry({
    bindings: {
      feishu: { fields: { appId: 'cli_x', appSecret: 'sec', domain: 'feishu' }, boundAt: 999 },
      weixin: { fields: { WEIXIN_TOKEN: 't' } }, // unknown/coming-soon → dropped
      dingtalk: { fields: {} } // unknown here → dropped
    }
  })
  assert.deepEqual(Object.keys(store), ['feishu'])
  assert.equal(store.feishu.boundAt, 999)
  assert.equal(store.feishu.fields.appId, 'cli_x')
})

test('normalizeStoredImEntry drops a feishu record whose secret was lost (decrypt blanked)', () => {
  const store = normalizeStoredImEntry({
    bindings: { feishu: { fields: { appId: 'cli_x', appSecret: '' }, boundAt: 1 } }
  })
  assert.deepEqual(store, {})
})

test('buildImEntrySpawnEnv emits descriptor keys and is empty when unbound', () => {
  assert.deepEqual(buildImEntrySpawnEnv({}), {})
  assert.deepEqual(buildImEntrySpawnEnv(null), {})

  const store = normalizeStoredImEntry({
    bindings: { feishu: { fields: { appId: 'cli_x', appSecret: 'sec', domain: 'lark' } } }
  })
  assert.deepEqual(buildImEntrySpawnEnv(store), {
    FEISHU_APP_ID: 'cli_x',
    FEISHU_APP_SECRET: 'sec',
    FEISHU_DOMAIN: 'lark'
  })
})

test('buildImEntrySpawnEnv omits an absent optional domain key entirely', () => {
  const store = normalizeStoredImEntry({
    bindings: { feishu: { fields: { appId: 'cli_x', appSecret: 'sec' } } }
  })
  const env = buildImEntrySpawnEnv(store)
  assert.equal(env.FEISHU_APP_ID, 'cli_x')
  assert.equal(env.FEISHU_APP_SECRET, 'sec')
  assert.equal('FEISHU_DOMAIN' in env, false)
})

test('resolveFeishuIssueEndpoints composes from apiBase, honors env overrides', () => {
  const composed = resolveFeishuIssueEndpoints('https://api.apex-nodes.com/', {})
  assert.equal(composed.issueUrl, `https://api.apex-nodes.com${FEISHU_ISSUE_PATH}`)
  assert.equal(composed.pollUrl, `https://api.apex-nodes.com${FEISHU_POLL_PATH}`)

  const overridden = resolveFeishuIssueEndpoints('https://api.apex-nodes.com', {
    HERMES_DESKTOP_IM_FEISHU_ISSUE_URL: 'https://staging.example.com/issue',
    HERMES_DESKTOP_IM_FEISHU_POLL_URL: 'https://staging.example.com/poll'
  })
  assert.equal(overridden.issueUrl, 'https://staging.example.com/issue')
  assert.equal(overridden.pollUrl, 'https://staging.example.com/poll')
})

test('parseFeishuIssueResponse shapes a valid body + defaults interval/expiry', () => {
  const parsed = parseFeishuIssueResponse({
    device_code: 'dc_1',
    scan_url: 'https://applink.feishu.cn/xyz',
    qr_url: 'https://cdn/x.png',
    interval: 5,
    expires_in: 600
  })
  assert.deepEqual(parsed, {
    deviceCode: 'dc_1',
    scanUrl: 'https://applink.feishu.cn/xyz',
    qrUrl: 'https://cdn/x.png',
    intervalMs: 5000,
    expiresInMs: 600000
  })

  // Accepts the OAuth-style verification_uri_complete alias for the scan URL.
  assert.equal(
    parseFeishuIssueResponse({ device_code: 'd', verification_uri_complete: 'https://v/c' }).scanUrl,
    'https://v/c'
  )
  // Missing device_code or scan URL → null.
  assert.equal(parseFeishuIssueResponse({ scan_url: 'https://v/c' }), null)
  assert.equal(parseFeishuIssueResponse({ device_code: 'd' }), null)
  assert.equal(parseFeishuIssueResponse(null), null)
  // Bad interval/expiry fall back to sane defaults.
  const d = parseFeishuIssueResponse({ device_code: 'd', scan_url: 'u', interval: -1, expires_in: 'x' })
  assert.equal(d.intervalMs, 3000)
  assert.equal(d.expiresInMs, 300000)
})

test('parseFeishuPollResponse: non-terminal statuses carry no credential', () => {
  assert.deepEqual(parseFeishuPollResponse({ status: 'pending' }), { status: 'pending', credential: null })
  assert.deepEqual(parseFeishuPollResponse({ status: 'scanned' }), { status: 'scanned', credential: null })
  assert.deepEqual(parseFeishuPollResponse({ status: 'expired' }), { status: 'expired', credential: null })
  assert.deepEqual(parseFeishuPollResponse({ status: 'denied' }), { status: 'denied', credential: null })
  // Unknown status → keep polling.
  assert.deepEqual(parseFeishuPollResponse({ status: 'weird' }), { status: 'pending', credential: null })
  assert.deepEqual(parseFeishuPollResponse(null), { status: 'pending', credential: null })
})

test('parseFeishuPollResponse: authorized yields a credential, or degrades without one', () => {
  const ok = parseFeishuPollResponse({
    status: 'authorized',
    credential: { app_id: 'cli_a', app_secret: 'sec', domain: 'lark' }
  })
  assert.deepEqual(ok, { status: 'authorized', credential: { appId: 'cli_a', appSecret: 'sec', domain: 'lark' } })

  // Authorized but no usable credential → keep polling, never false-succeed.
  assert.deepEqual(parseFeishuPollResponse({ status: 'authorized', credential: { app_id: 'cli_a' } }), {
    status: 'pending',
    credential: null
  })
  assert.deepEqual(parseFeishuPollResponse({ status: 'authorized' }), { status: 'pending', credential: null })
})

test('normalizeFeishuDomain clamps to feishu|lark', () => {
  assert.equal(normalizeFeishuDomain('lark'), 'lark')
  assert.equal(normalizeFeishuDomain('FEISHU'), 'feishu')
  assert.equal(normalizeFeishuDomain('garbage'), 'feishu')
  assert.equal(normalizeFeishuDomain(undefined), 'feishu')
})
