/**
 * Tests for electron/apex-agent-auth.cjs (hc-545).
 *
 * Run with: node --test electron/apex-agent-auth.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * The anti-conflation classifier is the heart: credential-presence and
 * reachability are separate axes, and a logged-in-but-unreachable agent must
 * report `unreachable`, never `logged_out`. Also covers the CLI status parsers,
 * OAuth-URL extraction, the CONNECT status parse, and the two detect
 * orchestrators driven by injected fakes (no real CLI / socket).
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  AGENT_STATE,
  classifyAgentState,
  extractEmail,
  parseClaudeAuthStatus,
  parseCodexAuthJson,
  parseCodexLoginStatus,
  decodeJwtEmail,
  extractOAuthUrl,
  parseConnectStatus,
  proxyEndpoint,
  probeReachable,
  detectClaude,
  detectCodex
} = require('./apex-agent-auth.cjs')

// --- classifier: the anti-conflation matrix --------------------------------

test('classifyAgentState: not installed → NO_CLI regardless of other signals', () => {
  assert.equal(classifyAgentState({ cliPresent: false, loggedIn: true, reachable: true }), AGENT_STATE.NO_CLI)
  assert.equal(classifyAgentState({ cliPresent: false }), AGENT_STATE.NO_CLI)
})

test('classifyAgentState: logged out wins even when the network is fine', () => {
  assert.equal(classifyAgentState({ cliPresent: true, loggedIn: false, reachable: true }), AGENT_STATE.LOGGED_OUT)
})

test('classifyAgentState: THE trap — logged in but unreachable is UNREACHABLE, not LOGGED_OUT', () => {
  assert.equal(classifyAgentState({ cliPresent: true, loggedIn: true, reachable: false }), AGENT_STATE.UNREACHABLE)
})

test('classifyAgentState: logged in + reachable → READY', () => {
  assert.equal(classifyAgentState({ cliPresent: true, loggedIn: true, reachable: true }), AGENT_STATE.READY)
})

test('classifyAgentState: logged in, reachability not probed → optimistic READY (never fake UNREACHABLE)', () => {
  assert.equal(classifyAgentState({ cliPresent: true, loggedIn: true, reachable: null }), AGENT_STATE.READY)
  assert.equal(classifyAgentState({ cliPresent: true, loggedIn: true }), AGENT_STATE.READY)
})

test('classifyAgentState: indeterminate credential → UNKNOWN (never guess)', () => {
  assert.equal(classifyAgentState({ cliPresent: true, loggedIn: null, reachable: true }), AGENT_STATE.UNKNOWN)
  assert.equal(classifyAgentState({ cliPresent: true }), AGENT_STATE.UNKNOWN)
})

test('extractEmail: pulls an email from free text; empty when none', () => {
  assert.equal(extractEmail('signed in as a.b+tag@example.co.uk today'), 'a.b+tag@example.co.uk')
  assert.equal(extractEmail('no address here'), '')
})

// --- claude auth status parsing --------------------------------------------

test('parseClaudeAuthStatus: JSON logged in with email + plan', () => {
  const out = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.com","subscriptionType":"max"}')
  assert.equal(out.loggedIn, true)
  assert.equal(out.email, 'a@b.com')
  assert.equal(out.plan, 'max')
})

test('parseClaudeAuthStatus: JSON logged out', () => {
  const out = parseClaudeAuthStatus('{"loggedIn":false}')
  assert.equal(out.loggedIn, false)
  assert.equal(out.email, '')
})

test('parseClaudeAuthStatus: tolerates a banner line before JSON', () => {
  const out = parseClaudeAuthStatus('Checking auth...\n{"loggedIn":true,"email":"c@d.com"}')
  assert.equal(out.loggedIn, true)
  assert.equal(out.email, 'c@d.com')
})

test('parseClaudeAuthStatus: text fallback for a non-JSON CLI', () => {
  assert.equal(parseClaudeAuthStatus('You are not logged in.').loggedIn, false)
  assert.equal(parseClaudeAuthStatus('Logged in as x@y.com').loggedIn, true)
  assert.equal(parseClaudeAuthStatus('Logged in as x@y.com').email, 'x@y.com')
})

test('parseClaudeAuthStatus: gibberish → indeterminate (null)', () => {
  assert.equal(parseClaudeAuthStatus('???').loggedIn, null)
  assert.equal(parseClaudeAuthStatus('').loggedIn, null)
})

// --- codex parsing ----------------------------------------------------------

test('parseCodexAuthJson: OAuth tokens → logged in + email from id_token', () => {
  // id_token payload {"email":"cx@e.com"} → base64url
  const payload = Buffer.from(JSON.stringify({ email: 'cx@e.com' })).toString('base64').replace(/=+$/, '')
  const idToken = `h.${payload}.s`
  const out = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: 'tok', id_token: idToken }, auth_mode: 'chatgpt' }))
  assert.equal(out.loggedIn, true)
  assert.equal(out.mode, 'chatgpt')
  assert.equal(out.email, 'cx@e.com')
})

test('parseCodexAuthJson: bare OPENAI_API_KEY → logged in (apikey)', () => {
  const out = parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: 'sk-xxx', tokens: {} }))
  assert.equal(out.loggedIn, true)
  assert.equal(out.mode, 'apikey')
})

test('parseCodexAuthJson: no tokens / no key → logged out', () => {
  assert.equal(parseCodexAuthJson(JSON.stringify({ tokens: {} })).loggedIn, false)
})

test('parseCodexAuthJson: unparseable → indeterminate (null)', () => {
  assert.equal(parseCodexAuthJson('not json').loggedIn, null)
  assert.equal(parseCodexAuthJson('').loggedIn, null)
})

test('parseCodexLoginStatus: logged in / out / indeterminate', () => {
  assert.equal(parseCodexLoginStatus('Logged in using ChatGPT').loggedIn, true)
  assert.equal(parseCodexLoginStatus('Not logged in').loggedIn, false)
  assert.equal(parseCodexLoginStatus('weird').loggedIn, null)
})

test('decodeJwtEmail: extracts email from a JWT payload; empty on junk', () => {
  const payload = Buffer.from(JSON.stringify({ preferred_username: 'u@v.com' })).toString('base64').replace(/=+$/, '')
  assert.equal(decodeJwtEmail(`a.${payload}.c`), 'u@v.com')
  assert.equal(decodeJwtEmail('nope'), '')
  assert.equal(decodeJwtEmail(''), '')
})

// --- OAuth URL extraction ---------------------------------------------------

test('extractOAuthUrl: prefers an authorize-looking link', () => {
  const text = 'Visit https://example.com/docs then open https://claude.ai/oauth/authorize?code=1 to continue.'
  assert.equal(extractOAuthUrl(text), 'https://claude.ai/oauth/authorize?code=1')
})

test('extractOAuthUrl: trims trailing prose punctuation', () => {
  assert.equal(extractOAuthUrl('Open https://auth.openai.com/activate.'), 'https://auth.openai.com/activate')
})

test('extractOAuthUrl: falls back to first https URL, empty when none', () => {
  assert.equal(extractOAuthUrl('see https://plain.example.com/x here'), 'https://plain.example.com/x')
  assert.equal(extractOAuthUrl('no links here'), '')
})

// --- CONNECT + proxy endpoint ----------------------------------------------

test('parseConnectStatus: 2xx ok, others not', () => {
  assert.deepEqual(parseConnectStatus('HTTP/1.1 200 Connection established\r\n'), { statusCode: 200, ok: true })
  assert.deepEqual(parseConnectStatus('HTTP/1.1 403 Forbidden\r\n'), { statusCode: 403, ok: false })
  assert.deepEqual(parseConnectStatus('garbage'), { statusCode: 0, ok: false })
})

test('proxyEndpoint: parses http proxy host:port; rejects socks/empty', () => {
  assert.deepEqual(proxyEndpoint('http://127.0.0.1:1081'), { host: '127.0.0.1', port: 1081 })
  assert.deepEqual(proxyEndpoint('http://p.local'), { host: 'p.local', port: 80 })
  assert.equal(proxyEndpoint('socks5://127.0.0.1:1080'), null)
  assert.equal(proxyEndpoint(''), null)
})

// A fake socket that scripts the connect/data/error/timeout lifecycle.
function fakeSocketFactory(script) {
  return () => {
    const socket = new EventEmitter()
    socket.written = []
    socket.setTimeout = () => {}
    socket.destroy = () => {}
    socket.write = data => {
      socket.written.push(data)
      if (script.onWrite) setImmediate(() => script.onWrite(socket))
    }
    setImmediate(() => script.start(socket))
    return socket
  }
}

test('probeReachable: direct TCP connect success → true', async () => {
  const connect = fakeSocketFactory({ start: s => s.emit('connect') })
  assert.equal(await probeReachable({ host: 'api.anthropic.com', connect }), true)
})

test('probeReachable: direct TCP error → false', async () => {
  const connect = fakeSocketFactory({ start: s => s.emit('error', new Error('ECONNREFUSED')) })
  assert.equal(await probeReachable({ host: 'api.anthropic.com', connect }), false)
})

test('probeReachable: via proxy, CONNECT 200 → true', async () => {
  const connect = fakeSocketFactory({
    start: s => s.emit('connect'),
    onWrite: s => s.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'))
  })
  assert.equal(await probeReachable({ host: 'api.anthropic.com', proxyUrl: 'http://127.0.0.1:1081', connect }), true)
})

test('probeReachable: via proxy, CONNECT 403 → false', async () => {
  const connect = fakeSocketFactory({
    start: s => s.emit('connect'),
    onWrite: s => s.emit('data', Buffer.from('HTTP/1.1 403 Forbidden\r\n\r\n'))
  })
  assert.equal(await probeReachable({ host: 'api.anthropic.com', proxyUrl: 'http://127.0.0.1:1081', connect }), false)
})

// --- detect orchestrators (injected execFile / readFile / probe) -----------

// A fake execFile matching child_process.execFile(cmd, args, opts, cb).
function fakeExecFile(handler) {
  return (command, args, _opts, cb) => {
    const emitter = new EventEmitter()
    setImmediate(() => {
      const { error, stdout, stderr } = handler(command, args)
      cb(error || null, stdout || '', stderr || '')
    })
    return emitter
  }
}

test('detectClaude: ENOENT → NO_CLI', async () => {
  const execFile = fakeExecFile(() => ({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }))
  const out = await detectClaude({ env: {}, execFile, probe: async () => true })
  assert.equal(out.state, AGENT_STATE.NO_CLI)
  assert.equal(out.cliPresent, false)
})

test('detectClaude: logged in + reachable → READY with email', async () => {
  const execFile = fakeExecFile(() => ({ stdout: '{"loggedIn":true,"email":"k@l.com","subscriptionType":"max"}' }))
  const out = await detectClaude({ env: {}, execFile, probe: async () => true })
  assert.equal(out.state, AGENT_STATE.READY)
  assert.equal(out.email, 'k@l.com')
  assert.equal(out.plan, 'max')
})

test('detectClaude: logged in but unreachable → UNREACHABLE (the PM trap)', async () => {
  const execFile = fakeExecFile(() => ({ stdout: '{"loggedIn":true,"email":"k@l.com"}' }))
  let probed = false
  const out = await detectClaude({
    env: {},
    execFile,
    probe: async () => {
      probed = true
      return false
    }
  })
  assert.equal(out.state, AGENT_STATE.UNREACHABLE)
  assert.equal(probed, true) // reachability only probed once logged in
})

test('detectClaude: logged out → LOGGED_OUT and never probes the network', async () => {
  const execFile = fakeExecFile(() => ({ stdout: '{"loggedIn":false}' }))
  let probed = false
  const out = await detectClaude({
    env: {},
    execFile,
    probe: async () => {
      probed = true
      return true
    }
  })
  assert.equal(out.state, AGENT_STATE.LOGGED_OUT)
  assert.equal(probed, false)
})

test('detectCodex: auth.json with tokens → READY (no exec needed)', async () => {
  const readFile = () => JSON.stringify({ tokens: { access_token: 'x', id_token: '' }, auth_mode: 'chatgpt' })
  let execCalled = false
  const execFile = fakeExecFile(() => {
    execCalled = true
    return {}
  })
  const out = await detectCodex({ env: {}, homeDir: '/home/x', readFile, execFile, probe: async () => true })
  assert.equal(out.state, AGENT_STATE.READY)
  assert.equal(execCalled, false) // file signal short-circuits the CLI
})

test('detectCodex: no auth.json → falls back to `codex login status`', async () => {
  const readFile = () => {
    throw new Error('ENOENT')
  }
  const execFile = fakeExecFile(() => ({ stdout: 'Logged in using ChatGPT' }))
  const out = await detectCodex({ env: {}, homeDir: '/home/x', readFile, execFile, probe: async () => true })
  assert.equal(out.state, AGENT_STATE.READY)
})

test('detectCodex: no auth.json + codex missing → NO_CLI', async () => {
  const readFile = () => {
    throw new Error('ENOENT')
  }
  const execFile = fakeExecFile(() => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }))
  const out = await detectCodex({ env: {}, homeDir: '/home/x', readFile, execFile, probe: async () => true })
  assert.equal(out.state, AGENT_STATE.NO_CLI)
})
