/**
 * Tests for electron/apex-im-entry.cjs (hc-417 Desktop IM 入口 config pipeline).
 *
 * Run with: node --test electron/apex-im-entry.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * These are the pure helpers behind the pipeline: the channel env descriptors,
 * binding shaping + the required-field gate, stored-state normalization, the
 * spawn-env fragment builder (add-only, descriptor-keyed), the secret-field
 * classification the encrypt layer reads, the cloud v2 provisioning endpoint
 * resolution + its host allowlist, the provision/status/credentials response
 * parsers, and the .env FEISHU_* override stripper. Secret handling
 * (safeStorage) + IPC live in main.cjs; here we prove the shaping/gating logic.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FEISHU_PROVISION_CREDENTIALS_PATH,
  FEISHU_PROVISION_ENTRY_PATH,
  FEISHU_PROVISION_PATH,
  buildImEntrySpawnEnv,
  feishuProvisionPollUrl,
  isAllowedFeishuProvisionUrl,
  isKnownChannel,
  normalizeFeishuDomain,
  normalizeStoredImEntry,
  parseFeishuCredentialsV2Response,
  parseFeishuProvisionResponse,
  parseFeishuProvisionStatusResponse,
  resolveFeishuProvisionEndpoints,
  secretFieldsFor,
  shapeBinding,
  stripFeishuEnvOverrides
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

test('resolveFeishuProvisionEndpoints composes the cloud v2 paths from apiBase', () => {
  // The paths must be EXACTLY the hermes-cloud v2 contract (app/routers/desktop.py).
  assert.equal(FEISHU_PROVISION_PATH, '/api/v1/desktop/feishu/provision')
  assert.equal(FEISHU_PROVISION_CREDENTIALS_PATH, '/api/v1/desktop/feishu/credentials')
  assert.equal(FEISHU_PROVISION_ENTRY_PATH, '/api/v1/desktop/feishu/entry')

  const composed = resolveFeishuProvisionEndpoints('https://apex-nodes.com/', {})
  assert.equal(composed.provisionUrl, `https://apex-nodes.com${FEISHU_PROVISION_PATH}`)
  assert.equal(composed.credentialsUrl, `https://apex-nodes.com${FEISHU_PROVISION_CREDENTIALS_PATH}`)
  assert.equal(composed.entryUrl, `https://apex-nodes.com${FEISHU_PROVISION_ENTRY_PATH}`)

  const overridden = resolveFeishuProvisionEndpoints('https://apex-nodes.com', {
    HERMES_DESKTOP_IM_FEISHU_PROVISION_URL: 'https://staging.apex-nodes.com/provision',
    HERMES_DESKTOP_IM_FEISHU_CREDENTIALS_URL: 'https://staging.apex-nodes.com/credentials',
    HERMES_DESKTOP_IM_FEISHU_ENTRY_URL: 'https://staging.apex-nodes.com/entry'
  })
  assert.equal(overridden.provisionUrl, 'https://staging.apex-nodes.com/provision')
  assert.equal(overridden.credentialsUrl, 'https://staging.apex-nodes.com/credentials')
  assert.equal(overridden.entryUrl, 'https://staging.apex-nodes.com/entry')
})

test('feishuProvisionPollUrl appends the provision id as one URL-safe segment', () => {
  assert.equal(
    feishuProvisionPollUrl('https://apex-nodes.com/api/v1/desktop/feishu/provision', 'abc123'),
    'https://apex-nodes.com/api/v1/desktop/feishu/provision/abc123'
  )
  // A hostile/odd id can't smuggle path segments or a query.
  assert.equal(
    feishuProvisionPollUrl('https://apex-nodes.com/api/v1/desktop/feishu/provision/', '../entry?x=1'),
    'https://apex-nodes.com/api/v1/desktop/feishu/provision/..%2Fentry%3Fx%3D1'
  )
})

test('isAllowedFeishuProvisionUrl pins apex-nodes.com (https) + loopback (dev)', () => {
  assert.equal(isAllowedFeishuProvisionUrl('https://apex-nodes.com/api/v1/desktop/feishu/provision'), true)
  assert.equal(isAllowedFeishuProvisionUrl('https://api.apex-nodes.com/api/v1/desktop/feishu/provision'), true)
  assert.equal(isAllowedFeishuProvisionUrl('http://127.0.0.1:8000/api/v1/desktop/feishu/provision'), true)
  assert.equal(isAllowedFeishuProvisionUrl('http://localhost:8000/x'), true)

  // Foreign hosts, lookalikes, downgrades and garbage are all refused.
  assert.equal(isAllowedFeishuProvisionUrl('https://evil.example.com/steal'), false)
  assert.equal(isAllowedFeishuProvisionUrl('https://apex-nodes.com.evil.com/x'), false)
  assert.equal(isAllowedFeishuProvisionUrl('https://notapex-nodes.com/x'), false)
  assert.equal(isAllowedFeishuProvisionUrl('http://apex-nodes.com/x'), false) // https only off loopback
  assert.equal(isAllowedFeishuProvisionUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedFeishuProvisionUrl('not a url'), false)
  assert.equal(isAllowedFeishuProvisionUrl(''), false)
  assert.equal(isAllowedFeishuProvisionUrl(null), false)
})

test('parseFeishuProvisionResponse shapes a valid body + defaults interval/expiry', () => {
  const parsed = parseFeishuProvisionResponse({
    provision_id: 'p_1',
    qr_url: 'https://applink.feishu.cn/xyz?from=sdk',
    interval: 5,
    expires_in: 600
  })
  assert.deepEqual(parsed, {
    provisionId: 'p_1',
    qrUrl: 'https://applink.feishu.cn/xyz?from=sdk',
    intervalMs: 5000,
    expiresInMs: 600000
  })

  // Missing provision_id or qr_url → null (never a half-usable flow).
  assert.equal(parseFeishuProvisionResponse({ qr_url: 'https://v/c' }), null)
  assert.equal(parseFeishuProvisionResponse({ provision_id: 'p' }), null)
  assert.equal(parseFeishuProvisionResponse(null), null)
  assert.equal(parseFeishuProvisionResponse([]), null)
  // Bad interval/expiry fall back to sane defaults.
  const d = parseFeishuProvisionResponse({ provision_id: 'p', qr_url: 'u', interval: -1, expires_in: 'x' })
  assert.equal(d.intervalMs, 3000)
  assert.equal(d.expiresInMs, 300000)
})

test('parseFeishuProvisionStatusResponse accepts the v2 status set, never a credential', () => {
  assert.deepEqual(parseFeishuProvisionStatusResponse({ status: 'pending' }), { status: 'pending', agentName: '' })
  assert.deepEqual(parseFeishuProvisionStatusResponse({ status: 'denied' }), { status: 'denied', agentName: '' })
  assert.deepEqual(parseFeishuProvisionStatusResponse({ status: 'expired' }), { status: 'expired', agentName: '' })
  assert.deepEqual(parseFeishuProvisionStatusResponse({ status: 'success', agent_name: 'My Agent' }), {
    status: 'success',
    agentName: 'My Agent'
  })

  // v1 vocabulary ('authorized'/'scanned') and unknown statuses degrade to
  // pending — keep polling, never wedge or false-succeed.
  assert.equal(parseFeishuProvisionStatusResponse({ status: 'authorized' }).status, 'pending')
  assert.equal(parseFeishuProvisionStatusResponse({ status: 'scanned' }).status, 'pending')
  assert.equal(parseFeishuProvisionStatusResponse({ status: 'weird' }).status, 'pending')
  assert.equal(parseFeishuProvisionStatusResponse(null).status, 'pending')
})

test('parseFeishuCredentialsV2Response requires app_id + app_secret, clamps domain', () => {
  assert.deepEqual(
    parseFeishuCredentialsV2Response({ app_id: ' cli_a ', app_secret: ' sec ', domain: 'lark' }),
    { appId: 'cli_a', appSecret: 'sec', domain: 'lark' }
  )
  // Domain garbage/missing → runtime default, never emitted raw.
  assert.equal(parseFeishuCredentialsV2Response({ app_id: 'a', app_secret: 's', domain: 'nope' }).domain, 'feishu')
  assert.equal(parseFeishuCredentialsV2Response({ app_id: 'a', app_secret: 's' }).domain, 'feishu')

  // Anything that can't yield an injectable credential → null.
  assert.equal(parseFeishuCredentialsV2Response({ app_id: 'a' }), null)
  assert.equal(parseFeishuCredentialsV2Response({ app_secret: 's' }), null)
  assert.equal(parseFeishuCredentialsV2Response({}), null)
  assert.equal(parseFeishuCredentialsV2Response(null), null)
})

test('normalizeFeishuDomain clamps to feishu|lark', () => {
  assert.equal(normalizeFeishuDomain('lark'), 'lark')
  assert.equal(normalizeFeishuDomain('FEISHU'), 'feishu')
  assert.equal(normalizeFeishuDomain('garbage'), 'feishu')
  assert.equal(normalizeFeishuDomain(undefined), 'feishu')
})

test('stripFeishuEnvOverrides removes every FEISHU_* assignment, preserves the rest', () => {
  const input = [
    '# my env',
    'OPENAI_API_KEY=sk-keep',
    'FEISHU_APP_ID=cli_stale',
    'export FEISHU_APP_SECRET=old-secret',
    '  FEISHU_DOMAIN = lark',
    'FEISHU_WEBHOOK_TOKEN="quoted"',
    '',
    'OTHER=1'
  ].join('\n')

  const { text, removed } = stripFeishuEnvOverrides(input)
  assert.deepEqual(removed, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN', 'FEISHU_WEBHOOK_TOKEN'])
  assert.equal(text, ['# my env', 'OPENAI_API_KEY=sk-keep', '', 'OTHER=1'].join('\n'))
})

test('stripFeishuEnvOverrides leaves non-FEISHU and commented lines untouched', () => {
  const untouched = ['# FEISHU_APP_ID=commented-out', 'MY_FEISHU_APP_ID=not-a-feishu-prefix', 'A=1'].join('\n')
  assert.deepEqual(stripFeishuEnvOverrides(untouched), { text: untouched, removed: [] })

  // Garbage in → unchanged out, never a throw.
  assert.deepEqual(stripFeishuEnvOverrides(''), { text: '', removed: [] })
  assert.deepEqual(stripFeishuEnvOverrides(null), { text: '', removed: [] })
})
