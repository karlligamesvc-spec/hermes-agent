'use strict'

/**
 * apex-agent-auth.cjs — in-app account-connection UX for the coding agents (hc-545).
 *
 * The direct-passthrough / daemon legs drive the user's own `claude` / `codex`
 * CLI on this machine, which authenticate from their own credential stores
 * (Claude → macOS Keychain via `claude auth`; Codex → ~/.codex/auth.json). PM's
 * real-machine run hit three walls a normal user can't clear from a terminal:
 *   1. not signed in,
 *   2. signed in but `api.anthropic.com` geo-blocked (needs a proxy),
 *   3. an old CLI.
 * Worst of all, (1) and (2) look identical from the outside — and `/cc list`
 * (no auth needed) masked (1) entirely.
 *
 * The core here is the ANTI-CONFLATION classifier: credential-presence and
 * network-reachability are gathered as SEPARATE signals and only combined at the
 * end, so a logged-in-but-unreachable agent reports `unreachable` (fix: proxy),
 * never `logged_out` (fix: sign in). Getting this wrong is the exact trap PM
 * fell into.
 *
 * Boundary (§4 / red lines): we only ever host the login of the CLIs THIS app
 * itself drives (claude/codex) — never a third party. OAuth credentials land in
 * each CLI's own store; we neither read, persist, nor upload them. All the
 * decision logic (classifier, status parsers, URL extraction) is pure and
 * table-tested; the spawns/network are thin, injectable wrappers.
 */

const net = require('node:net')

const AGENT_STATE = Object.freeze({
  NO_CLI: 'no_cli', // binary not on PATH — needs install
  LOGGED_OUT: 'logged_out', // reachable-or-not, but no valid credential — needs sign in
  UNREACHABLE: 'unreachable', // has credential, but the provider API can't be reached — needs proxy
  READY: 'ready', // credential present + reachable
  UNKNOWN: 'unknown' // couldn't determine (probe error) — surfaced honestly, not faked green
})

const CLAUDE_REACH_HOST = 'api.anthropic.com'
const CODEX_REACH_HOST = 'chatgpt.com'
const REACH_PORT = 443
const REACH_TIMEOUT_MS = 4000
const STATUS_TIMEOUT_MS = 8000

/**
 * The whole three-state decision, pure. Credential-presence (`loggedIn`) and
 * reachability (`reachable`) are independent inputs:
 *   - !cliPresent            → NO_CLI
 *   - loggedIn === false     → LOGGED_OUT   (regardless of reachability)
 *   - loggedIn indeterminate → UNKNOWN      (never guess "ready" or "logged out")
 *   - loggedIn && reachable===false → UNREACHABLE
 *   - loggedIn && otherwise  → READY        (reachable true OR not probed)
 *
 * `reachable` left undefined/null (probe skipped or inconclusive) is treated
 * optimistically as ready — we only claim UNREACHABLE on a POSITIVE failure, so
 * a flaky probe never masquerades as a login problem.
 */
function classifyAgentState({ cliPresent, loggedIn, reachable } = {}) {
  if (!cliPresent) return AGENT_STATE.NO_CLI
  if (loggedIn === false) return AGENT_STATE.LOGGED_OUT
  if (loggedIn !== true) return AGENT_STATE.UNKNOWN
  if (reachable === false) return AGENT_STATE.UNREACHABLE
  return AGENT_STATE.READY
}

/** Extract an email-shaped token from free text. Pure. */
function extractEmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match ? match[0] : ''
}

/**
 * Parse `claude auth status --json` output. Pure. Returns
 * `{ loggedIn, email, plan, authMethod }` where `loggedIn` is `true`/`false`
 * when known and `null` when indeterminate (so the classifier reports UNKNOWN
 * rather than guessing). Tolerates a banner line before the JSON body and falls
 * back to a text scan for older CLIs that don't emit JSON.
 */
function parseClaudeAuthStatus(stdout) {
  const text = String(stdout || '').trim()
  const braceAt = text.indexOf('{')
  if (braceAt >= 0) {
    try {
      const data = JSON.parse(text.slice(braceAt))
      if (typeof data.loggedIn === 'boolean') {
        return {
          loggedIn: data.loggedIn,
          email: typeof data.email === 'string' ? data.email : '',
          plan: typeof data.subscriptionType === 'string' ? data.subscriptionType : '',
          authMethod: typeof data.authMethod === 'string' ? data.authMethod : ''
        }
      }
    } catch {
      // fall through to text scan
    }
  }
  if (/not\s+logged\s+in|logged\s+out|not\s+authenticated|no\s+(?:active\s+)?(?:account|auth|credential)/i.test(text)) {
    return { loggedIn: false, email: '', plan: '', authMethod: '' }
  }
  if (/logged\s+in|authenticated|signed\s+in/i.test(text)) {
    return { loggedIn: true, email: extractEmail(text), plan: '', authMethod: '' }
  }
  return { loggedIn: null, email: '', plan: '', authMethod: '' }
}

/** Best-effort decode of an OAuth id_token's `email`/`preferred_username`. Pure. */
function decodeJwtEmail(idToken) {
  const parts = String(idToken || '').split('.')
  if (parts.length < 2) return ''
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(payload, 'base64').toString('utf8')
    const claims = JSON.parse(json)
    const email = claims.email || claims.preferred_username || ''
    if (typeof email === 'string') return email
    // Codex nests some claims under an auth namespace object.
    for (const value of Object.values(claims)) {
      if (value && typeof value === 'object' && typeof value.email === 'string') return value.email
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Parse a `~/.codex/auth.json` document. Pure. Logged-in iff an OAuth
 * access_token or an OPENAI_API_KEY is present. `loggedIn` is `null` on an
 * unparseable/absent file so the caller can distinguish "no file" from "file
 * says logged out".
 */
function parseCodexAuthJson(text) {
  let data
  try {
    data = JSON.parse(String(text || ''))
  } catch {
    return { loggedIn: null, email: '', mode: '' }
  }
  if (!data || typeof data !== 'object') return { loggedIn: null, email: '', mode: '' }
  const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null
  const hasOAuth = Boolean(tokens && String(tokens.access_token || '').trim())
  const hasApiKey = Boolean(String(data.OPENAI_API_KEY || '').trim())
  if (hasOAuth || hasApiKey) {
    const mode = typeof data.auth_mode === 'string' && data.auth_mode ? data.auth_mode : hasApiKey ? 'apikey' : 'chatgpt'
    return { loggedIn: true, email: tokens ? decodeJwtEmail(tokens.id_token) : '', mode }
  }
  return { loggedIn: false, email: '', mode: '' }
}

/** Parse `codex login status` output. Pure. */
function parseCodexLoginStatus(stdout) {
  const text = String(stdout || '').trim()
  if (/not\s+logged\s+in|logged\s+out|no\s+credential/i.test(text)) return { loggedIn: false, email: '' }
  if (/logged\s+in|authenticated/i.test(text)) return { loggedIn: true, email: extractEmail(text) }
  return { loggedIn: null, email: '' }
}

/**
 * Extract the OAuth authorize URL a `login` CLI prints. Pure. Prefers a link
 * that looks like an auth/authorize/activate endpoint; otherwise returns the
 * first https URL. Trailing punctuation from prose is trimmed.
 */
function extractOAuthUrl(text) {
  const source = String(text || '')
  const regex = /(https:\/\/[^\s'"<>]+)/g
  let match
  let firstUrl = ''
  while ((match = regex.exec(source)) !== null) {
    const url = match[1].replace(/[.,);:]+$/, '')
    if (/(oauth|authorize|\/activate|\/auth\b|auth\.|callback|claude\.ai|anthropic\.com|openai\.com|chatgpt\.com)/i.test(url)) {
      return url
    }
    if (!firstUrl) firstUrl = url
  }
  return firstUrl
}

/** Parse an HTTP CONNECT proxy response's status line. Pure. 2xx = tunnel open. */
function parseConnectStatus(text) {
  const match = String(text || '').match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)
  const statusCode = match ? Number(match[1]) : 0
  return { statusCode, ok: statusCode >= 200 && statusCode < 300 }
}

/** Parse a proxy URL into `{ host, port }` for the CONNECT socket. Pure. */
function proxyEndpoint(proxyUrl) {
  if (!proxyUrl) return null
  try {
    const url = new URL(proxyUrl)
    if (!/^https?:$/i.test(url.protocol)) return null // CONNECT only over an HTTP proxy
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) }
  } catch {
    return null
  }
}

/**
 * Reachability probe (thin). With an HTTP proxy: open the socket to the proxy
 * and issue CONNECT <host>:443 — a 2xx tunnel proves the proxy can egress to the
 * provider. Without a proxy: a plain TCP connect to <host>:443. Any transport
 * failure/timeout resolves `false`. Never rejects.
 */
function probeReachable({ host, port = REACH_PORT, proxyUrl = '', timeoutMs = REACH_TIMEOUT_MS, connect = net.connect } = {}) {
  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve(value)
    }
    const endpoint = proxyEndpoint(proxyUrl)
    const target = endpoint || { host, port }
    let socket
    try {
      socket = connect({ host: target.host, port: target.port })
    } catch {
      resolve(false)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.once('connect', () => {
      if (!endpoint) {
        done(true) // direct TCP reached the provider
        return
      }
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    })
    if (endpoint) {
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8')
        if (buffer.includes('\r\n') || buffer.length > 256) {
          done(parseConnectStatus(buffer).ok)
        }
      })
    }
  })
}

/**
 * Run a CLI command capturing stdout/stderr, resolving `{ code, stdout, stderr,
 * spawnError }`. Never rejects. `spawnError` carries ENOENT so a caller can tell
 * "binary missing" from "ran and failed". Thin.
 */
function runCli(command, args, { env, cwd, timeoutMs = STATUS_TIMEOUT_MS, execFile } = {}) {
  const runner = execFile || require('node:child_process').execFile
  return new Promise(resolve => {
    let child
    try {
      child = runner(
        command,
        args,
        { env, cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const spawnError = error && (error.code === 'ENOENT' || /ENOENT/.test(String(error.message))) ? 'ENOENT' : ''
          resolve({
            code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            spawnError
          })
        }
      )
    } catch {
      resolve({ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' })
      return
    }
    child.on('error', () => {
      /* handled by the callback's error arg */
    })
  })
}

/**
 * Detect Claude Code auth state (thin orchestrator). Gathers the credential
 * signal from `claude auth status --json`, then — only if logged in — the
 * reachability signal, then classifies. `env` should carry the augmented PATH
 * (so `claude` resolves in a GUI-launched app), the real HOME, and any resolved
 * proxy fragment (so status + reachability travel the same path the agent will).
 */
async function detectClaude({ env, execFile, probe = probeReachable, proxyUrl = '' } = {}) {
  const result = await runCli('claude', ['auth', 'status', '--json'], { env, execFile })
  if (result.spawnError === 'ENOENT') {
    return { family: 'claude', state: AGENT_STATE.NO_CLI, cliPresent: false, loggedIn: null, reachable: null, email: '', plan: '' }
  }
  const parsed = parseClaudeAuthStatus(result.stdout || result.stderr)
  let reachable = null
  if (parsed.loggedIn === true) {
    reachable = await probe({ host: CLAUDE_REACH_HOST, proxyUrl })
  }
  return {
    family: 'claude',
    state: classifyAgentState({ cliPresent: true, loggedIn: parsed.loggedIn, reachable }),
    cliPresent: true,
    loggedIn: parsed.loggedIn,
    reachable,
    email: parsed.email,
    plan: parsed.plan
  }
}

/**
 * Detect Codex auth state (thin orchestrator). Prefers the file signal
 * (~/.codex/auth.json — no exec, no network), falls back to `codex login
 * status` when the file is absent/unparseable, then adds reachability.
 */
async function detectCodex({ env, homeDir, execFile, readFile, probe = probeReachable, proxyUrl = '' } = {}) {
  const path = require('node:path')
  const fs = require('node:fs')
  const reader = readFile || (p => fs.readFileSync(p, 'utf8'))
  const home = homeDir || (env && env.HOME) || require('node:os').homedir()

  let parsed = { loggedIn: null, email: '', mode: '' }
  let cliPresent = true
  try {
    parsed = parseCodexAuthJson(reader(path.join(home, '.codex', 'auth.json')))
  } catch {
    parsed = { loggedIn: null, email: '', mode: '' }
  }
  if (parsed.loggedIn === null) {
    const result = await runCli('codex', ['login', 'status'], { env, execFile })
    if (result.spawnError === 'ENOENT') {
      return { family: 'codex', state: AGENT_STATE.NO_CLI, cliPresent: false, loggedIn: null, reachable: null, email: '', plan: '' }
    }
    const status = parseCodexLoginStatus(result.stdout || result.stderr)
    parsed = { loggedIn: status.loggedIn, email: status.email, mode: '' }
  }
  let reachable = null
  if (parsed.loggedIn === true) {
    reachable = await probe({ host: CODEX_REACH_HOST, proxyUrl })
  }
  return {
    family: 'codex',
    state: classifyAgentState({ cliPresent, loggedIn: parsed.loggedIn, reachable }),
    cliPresent,
    loggedIn: parsed.loggedIn,
    reachable,
    email: parsed.email,
    plan: parsed.mode
  }
}

module.exports = {
  AGENT_STATE,
  CLAUDE_REACH_HOST,
  CODEX_REACH_HOST,
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
  runCli,
  detectClaude,
  detectCodex
}
