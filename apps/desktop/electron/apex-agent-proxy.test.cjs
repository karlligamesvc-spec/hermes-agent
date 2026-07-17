/**
 * Tests for electron/apex-agent-proxy.cjs (hc-545).
 *
 * Run with: node --test electron/apex-agent-proxy.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * Pure surface: scutil parsing, enable-flag→URL mapping, custom-URL
 * normalization, NO_PROXY whitelist merge, and the add-only vs override env
 * fragment assembly across the three modes. readSystemProxy/resolveAgentProxyEnv
 * are exercised with an injected fake `exec` (no real scutil).
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  NO_PROXY_WHITELIST,
  PROXY_MODE_AUTO,
  PROXY_MODE_CUSTOM,
  PROXY_MODE_OFF,
  normalizeProxyMode,
  parseScutilProxy,
  systemProxyToUrls,
  normalizeCustomProxyUrl,
  buildNoProxyValue,
  buildProxyEnvFragment,
  readSystemProxy,
  resolveAgentProxyEnv,
  describeAgentProxy
} = require('./apex-agent-proxy.cjs')

// A representative `scutil --proxy` dump for a Clash-style local proxy on 1081.
const SCUTIL_ENABLED = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 1081
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 1081
  SOCKSEnable : 0
}`

const SCUTIL_DISABLED = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}`

test('parseScutilProxy reads enable/host/port triples', () => {
  const parsed = parseScutilProxy(SCUTIL_ENABLED)
  assert.equal(parsed.httpEnable, 1)
  assert.equal(parsed.httpProxy, '127.0.0.1')
  assert.equal(parsed.httpPort, 1081)
  assert.equal(parsed.httpsEnable, 1)
  assert.equal(parsed.httpsProxy, '127.0.0.1')
  assert.equal(parsed.httpsPort, 1081)
  assert.equal(parsed.socksEnable, 0)
})

test('parseScutilProxy tolerates junk / non-string', () => {
  assert.equal(parseScutilProxy('').httpEnable, 0)
  assert.equal(parseScutilProxy(null).httpsEnable, 0)
  assert.equal(parseScutilProxy(undefined).socksEnable, 0)
})

test('systemProxyToUrls honors enable flags', () => {
  const urls = systemProxyToUrls(parseScutilProxy(SCUTIL_ENABLED))
  assert.equal(urls.httpUrl, 'http://127.0.0.1:1081')
  assert.equal(urls.httpsUrl, 'http://127.0.0.1:1081')
  assert.equal(urls.allUrl, '')
})

test('systemProxyToUrls returns empty when disabled', () => {
  const urls = systemProxyToUrls(parseScutilProxy(SCUTIL_DISABLED))
  assert.deepEqual(urls, { httpUrl: '', httpsUrl: '', allUrl: '' })
})

test('systemProxyToUrls mirrors a single configured field onto the other', () => {
  const urls = systemProxyToUrls({ httpsEnable: 1, httpsProxy: '10.0.0.2', httpsPort: 7890 })
  assert.equal(urls.httpsUrl, 'http://10.0.0.2:7890')
  assert.equal(urls.httpUrl, 'http://10.0.0.2:7890') // mirrored
})

test('systemProxyToUrls builds socks5 all-proxy', () => {
  const urls = systemProxyToUrls({ socksEnable: 1, socksProxy: '127.0.0.1', socksPort: 7891 })
  assert.equal(urls.allUrl, 'socks5://127.0.0.1:7891')
})

test('normalizeCustomProxyUrl accepts host:port, schemes; rejects junk', () => {
  assert.equal(normalizeCustomProxyUrl('127.0.0.1:1081'), 'http://127.0.0.1:1081')
  assert.equal(normalizeCustomProxyUrl('http://p.local:8080'), 'http://p.local:8080')
  assert.equal(normalizeCustomProxyUrl('https://p.local:8080/'), 'https://p.local:8080')
  assert.equal(normalizeCustomProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
  assert.equal(normalizeCustomProxyUrl('ftp://nope'), '')
  assert.equal(normalizeCustomProxyUrl(''), '')
  assert.equal(normalizeCustomProxyUrl('   '), '')
})

test('buildNoProxyValue merges whitelist add-only and de-dups', () => {
  const value = buildNoProxyValue('example.com, 127.0.0.1')
  const parts = value.split(',')
  assert.equal(parts[0], 'example.com') // existing preserved, first
  assert.ok(parts.includes('apex-nodes.com'))
  assert.ok(parts.includes('.myqcloud.com'))
  assert.ok(parts.includes('feishu.cn'))
  assert.ok(parts.includes('deepseek.com'))
  // 127.0.0.1 present once despite being in both existing and whitelist
  assert.equal(parts.filter(p => p === '127.0.0.1').length, 1)
})

test('buildNoProxyValue tolerates empty existing', () => {
  const value = buildNoProxyValue('')
  assert.ok(value.startsWith('localhost'))
  assert.equal(value.split(',').length, NO_PROXY_WHITELIST.length)
})

test('AUTO fragment injects proxy + NO_PROXY when system proxy present', () => {
  const frag = buildProxyEnvFragment({
    mode: PROXY_MODE_AUTO,
    systemUrls: { httpUrl: 'http://127.0.0.1:1081', httpsUrl: 'http://127.0.0.1:1081', allUrl: '' },
    currentEnv: {}
  })
  assert.equal(frag.HTTPS_PROXY, 'http://127.0.0.1:1081')
  assert.equal(frag.https_proxy, 'http://127.0.0.1:1081')
  assert.equal(frag.HTTP_PROXY, 'http://127.0.0.1:1081')
  assert.ok(frag.NO_PROXY.includes('apex-nodes.com'))
  assert.ok(frag.no_proxy.includes('feishu.cn'))
})

test('AUTO is add-only: an existing parent HTTPS_PROXY is not clobbered', () => {
  const frag = buildProxyEnvFragment({
    mode: PROXY_MODE_AUTO,
    systemUrls: { httpUrl: 'http://127.0.0.1:1081', httpsUrl: 'http://127.0.0.1:1081', allUrl: '' },
    currentEnv: { HTTPS_PROXY: 'http://parent:9', HTTP_PROXY: 'http://parent:9' }
  })
  // Neither HTTPS_PROXY nor HTTP_PROXY re-emitted (both already set) → no proxy
  // injected → no NO_PROXY either.
  assert.equal(frag.HTTPS_PROXY, undefined)
  assert.equal(frag.HTTP_PROXY, undefined)
  assert.equal(frag.NO_PROXY, undefined)
})

test('AUTO with no system proxy injects nothing', () => {
  const frag = buildProxyEnvFragment({
    mode: PROXY_MODE_AUTO,
    systemUrls: { httpUrl: '', httpsUrl: '', allUrl: '' },
    currentEnv: {}
  })
  assert.deepEqual(frag, {})
})

test('CUSTOM overrides an existing parent proxy', () => {
  const frag = buildProxyEnvFragment({
    mode: PROXY_MODE_CUSTOM,
    customUrl: '127.0.0.1:7890',
    currentEnv: { HTTPS_PROXY: 'http://parent:9' }
  })
  assert.equal(frag.HTTPS_PROXY, 'http://127.0.0.1:7890') // user's explicit choice wins
  assert.equal(frag.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.ok(frag.NO_PROXY.includes('apex-nodes.com'))
})

test('CUSTOM socks maps to ALL_PROXY only', () => {
  const frag = buildProxyEnvFragment({
    mode: PROXY_MODE_CUSTOM,
    customUrl: 'socks5://127.0.0.1:1080',
    currentEnv: {}
  })
  assert.equal(frag.ALL_PROXY, 'socks5://127.0.0.1:1080')
  assert.equal(frag.HTTPS_PROXY, undefined)
  assert.ok(frag.NO_PROXY)
})

test('CUSTOM with invalid URL injects nothing (fail safe)', () => {
  assert.deepEqual(buildProxyEnvFragment({ mode: PROXY_MODE_CUSTOM, customUrl: 'ftp://x', currentEnv: {} }), {})
})

test('OFF injects nothing even with a system proxy', () => {
  const frag = buildProxyEnvFragment({
    mode: PROXY_MODE_OFF,
    systemUrls: { httpUrl: 'http://127.0.0.1:1081', httpsUrl: 'http://127.0.0.1:1081', allUrl: '' },
    currentEnv: {}
  })
  assert.deepEqual(frag, {})
})

test('normalizeProxyMode defaults unknown to AUTO', () => {
  assert.equal(normalizeProxyMode('auto'), 'auto')
  assert.equal(normalizeProxyMode('custom'), 'custom')
  assert.equal(normalizeProxyMode('off'), 'off')
  assert.equal(normalizeProxyMode('bogus'), 'auto')
  assert.equal(normalizeProxyMode(undefined), 'auto')
})

test('readSystemProxy uses injected exec on darwin, empty off-darwin', () => {
  const fakeExec = () => SCUTIL_ENABLED
  const parsed = readSystemProxy({ platform: 'darwin', exec: fakeExec })
  assert.equal(parsed.httpsPort, 1081)
  // Non-darwin never execs.
  let called = false
  const spyExec = () => {
    called = true
    return SCUTIL_ENABLED
  }
  const off = readSystemProxy({ platform: 'win32', exec: spyExec })
  assert.equal(off.httpEnable, 0)
  assert.equal(called, false)
})

test('readSystemProxy swallows exec failure', () => {
  const throwingExec = () => {
    throw new Error('scutil boom')
  }
  const parsed = readSystemProxy({ platform: 'darwin', exec: throwingExec })
  assert.equal(parsed.httpEnable, 0)
})

test('resolveAgentProxyEnv AUTO end-to-end through fake scutil', () => {
  const frag = resolveAgentProxyEnv({
    mode: PROXY_MODE_AUTO,
    currentEnv: {},
    platform: 'darwin',
    exec: () => SCUTIL_ENABLED
  })
  assert.equal(frag.HTTPS_PROXY, 'http://127.0.0.1:1081')
  assert.ok(frag.NO_PROXY.includes('weixin.qq.com'))
})

test('resolveAgentProxyEnv CUSTOM never reads scutil', () => {
  let called = false
  const frag = resolveAgentProxyEnv({
    mode: PROXY_MODE_CUSTOM,
    customUrl: '127.0.0.1:2080',
    currentEnv: {},
    platform: 'darwin',
    exec: () => {
      called = true
      return SCUTIL_ENABLED
    }
  })
  assert.equal(frag.HTTPS_PROXY, 'http://127.0.0.1:2080')
  assert.equal(called, false)
})

test('describeAgentProxy strips embedded credentials', () => {
  const desc = describeAgentProxy({ mode: PROXY_MODE_CUSTOM, customUrl: 'http://user:pass@127.0.0.1:1081' })
  assert.equal(desc.active, true)
  assert.equal(desc.url, 'http://127.0.0.1:1081') // no user:pass
  assert.equal(desc.url.includes('pass'), false)
})

test('describeAgentProxy OFF is inactive', () => {
  assert.deepEqual(describeAgentProxy({ mode: PROXY_MODE_OFF }), { mode: 'off', active: false, url: '' })
})
