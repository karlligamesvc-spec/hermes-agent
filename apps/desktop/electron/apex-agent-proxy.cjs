'use strict'

/**
 * apex-agent-proxy.cjs — system-proxy autopilot for the coding-agent leg (hc-545).
 *
 * The problem (PM real-machine, 2026-07-16): `api.anthropic.com` is geo-blocked
 * on the user's network, so a bare `claude` / `codex` subprocess hangs and reads
 * as "not logged in". The user solved it manually by exporting
 * `HTTPS_PROXY=127.0.0.1:1081` before launch — something a normal user can't do.
 *
 * This module reads the macOS *system* proxy (System Settings → Network → Proxies,
 * surfaced by `scutil --proxy`) and assembles an `HTTP(S)_PROXY` + `NO_PROXY`
 * env fragment that main.cjs folds into the backend (gateway) subprocess env.
 * Because `hermes_subprocess_env()` does NOT strip proxy vars, the fragment
 * propagates through the gateway to the spawned claude/codex child by plain env
 * inheritance — one injection point, no Python change.
 *
 * Three modes (settings card): AUTO follows the system proxy (default, 90%
 * zero-config), CUSTOM pins a user-supplied URL, OFF injects nothing.
 *
 * Two iron rules baked in here:
 *   - We only INJECT into a child's env; we never touch the OS proxy settings.
 *   - NO_PROXY carries a fixed whitelist of the platform's own mainland-China
 *     hosts (apex-nodes / COS / Feishu / WeChat / DeepSeek …) so domestic links
 *     stay on the direct fast path and are never dragged through the agent proxy.
 *
 * Everything except `readSystemProxy` is pure and table-tested
 * (apex-agent-proxy.test.cjs).
 */

const { execFileSync } = require('node:child_process')

// Hosts that must BYPASS the agent proxy (go direct). These are the platform's
// own control-plane + CN vendor links: routing them through an overseas proxy
// would be slower at best and break the domestic path at worst. Leading-dot and
// bare forms are both listed because different HTTP clients match differently.
const NO_PROXY_WHITELIST = Object.freeze([
  'localhost',
  '127.0.0.1',
  '::1',
  // Platform control plane + capability API alias.
  'apex-nodes.com',
  '.apex-nodes.com',
  // Tencent COS — desktop shell/engine feeds + tarballs (广州 bucket).
  'myqcloud.com',
  '.myqcloud.com',
  // Feishu / Lark — IM channel + provisioning.
  'feishu.cn',
  '.feishu.cn',
  'larksuite.com',
  '.larksuite.com',
  // WeChat (iLink) channel.
  'weixin.qq.com',
  '.weixin.qq.com',
  'qq.com',
  '.qq.com',
  // DeepSeek — default managed model vendor.
  'deepseek.com',
  '.deepseek.com',
  // hc-406 CN HuggingFace mirror (backend-env HF_ENDPOINT).
  'hf-mirror.com',
  '.hf-mirror.com',
  // Alibaba Cloud (百炼 / OSS) + Volcengine (ASR/豆包) — domestic vendors.
  'aliyuncs.com',
  '.aliyuncs.com',
  'volces.com',
  '.volces.com',
  'tencentcloudapi.com',
  '.tencentcloudapi.com'
])

const PROXY_MODE_AUTO = 'auto'
const PROXY_MODE_CUSTOM = 'custom'
const PROXY_MODE_OFF = 'off'
const PROXY_MODES = Object.freeze([PROXY_MODE_AUTO, PROXY_MODE_CUSTOM, PROXY_MODE_OFF])

/** Coerce an untrusted mode string to a known mode; default AUTO. */
function normalizeProxyMode(mode) {
  return PROXY_MODES.includes(mode) ? mode : PROXY_MODE_AUTO
}

/** First non-empty value among `keys` in `env` (upper/lower proxy var lookup). */
function firstEnvValue(env, keys) {
  for (const key of keys) {
    const value = env && env[key]
    if (value) return String(value)
  }
  return ''
}

/**
 * Parse `scutil --proxy` output into a flat descriptor. Pure.
 *
 * scutil prints a `<dictionary> { KEY : VALUE ... }` block, one `KEY : VALUE`
 * per line. We only care about the HTTP/HTTPS/SOCKS enable+host+port triples.
 */
function parseScutilProxy(text) {
  const out = {
    httpEnable: 0,
    httpProxy: '',
    httpPort: 0,
    httpsEnable: 0,
    httpsProxy: '',
    httpsPort: 0,
    socksEnable: 0,
    socksProxy: '',
    socksPort: 0
  }
  if (typeof text !== 'string') return out
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/)
    if (!match) continue
    const key = match[1]
    const value = match[2]
    switch (key) {
      case 'HTTPEnable':
        out.httpEnable = Number(value) || 0
        break
      case 'HTTPProxy':
        out.httpProxy = value
        break
      case 'HTTPPort':
        out.httpPort = Number(value) || 0
        break
      case 'HTTPSEnable':
        out.httpsEnable = Number(value) || 0
        break
      case 'HTTPSProxy':
        out.httpsProxy = value
        break
      case 'HTTPSPort':
        out.httpsPort = Number(value) || 0
        break
      case 'SOCKSEnable':
        out.socksEnable = Number(value) || 0
        break
      case 'SOCKSProxy':
        out.socksProxy = value
        break
      case 'SOCKSPort':
        out.socksPort = Number(value) || 0
        break
      default:
        break
    }
  }
  return out
}

/**
 * Turn a parsed scutil descriptor into proxy URLs, honoring the Enable flags.
 * Pure. A single configured field (only HTTP, say) is mirrored onto the other
 * so the agent's HTTPS calls are still covered.
 */
function systemProxyToUrls(parsed) {
  const urls = { httpUrl: '', httpsUrl: '', allUrl: '' }
  if (!parsed) return urls
  if (parsed.httpEnable === 1 && parsed.httpProxy) {
    urls.httpUrl = `http://${parsed.httpProxy}${parsed.httpPort ? `:${parsed.httpPort}` : ''}`
  }
  if (parsed.httpsEnable === 1 && parsed.httpsProxy) {
    urls.httpsUrl = `http://${parsed.httpsProxy}${parsed.httpsPort ? `:${parsed.httpsPort}` : ''}`
  }
  if (parsed.socksEnable === 1 && parsed.socksProxy) {
    urls.allUrl = `socks5://${parsed.socksProxy}${parsed.socksPort ? `:${parsed.socksPort}` : ''}`
  }
  if (!urls.httpsUrl && urls.httpUrl) urls.httpsUrl = urls.httpUrl
  if (!urls.httpUrl && urls.httpsUrl) urls.httpUrl = urls.httpsUrl
  return urls
}

/**
 * Validate + normalize a user-supplied custom proxy URL. Pure. Returns '' when
 * unusable. Accepts a bare `host:port` (defaults to http://) and http/https/
 * socks(5/5h) schemes.
 */
function normalizeCustomProxyUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const candidate = /^[a-z0-9]+:\/\//i.test(value) ? value : `http://${value}`
  try {
    const url = new URL(candidate)
    if (!/^(https?|socks5?|socks5h):$/i.test(url.protocol)) return ''
    if (!url.hostname) return ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/**
 * Merge the whitelist into an existing NO_PROXY value — add-only, de-duplicated,
 * existing entries preserved first. Pure.
 */
function buildNoProxyValue(existing) {
  const seen = new Set()
  const ordered = []
  const push = raw => {
    const entry = String(raw || '').trim()
    if (!entry) return
    const key = entry.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(entry)
  }
  String(existing || '')
    .split(',')
    .forEach(push)
  NO_PROXY_WHITELIST.forEach(push)
  return ordered.join(',')
}

/**
 * Build the proxy env fragment for a mode. Pure — the whole decision surface.
 *
 * AUTO is add-only: an explicit `*_PROXY` already in `currentEnv` (power user /
 * staging) is respected and never clobbered. CUSTOM is the user's deliberate
 * choice, so it overrides. OFF and "nothing to inject" both return `{}`.
 * NO_PROXY (+ lowercase twin) is emitted only when a proxy was actually set.
 */
function buildProxyEnvFragment({ mode, customUrl, systemUrls, currentEnv = {} } = {}) {
  const resolvedMode = normalizeProxyMode(mode)
  if (resolvedMode === PROXY_MODE_OFF) return {}

  let httpUrl = ''
  let httpsUrl = ''
  let allUrl = ''
  if (resolvedMode === PROXY_MODE_CUSTOM) {
    const normalized = normalizeCustomProxyUrl(customUrl)
    if (!normalized) return {}
    if (/^socks/i.test(normalized)) {
      allUrl = normalized
    } else {
      httpUrl = normalized
      httpsUrl = normalized
    }
  } else {
    httpUrl = systemUrls?.httpUrl || ''
    httpsUrl = systemUrls?.httpsUrl || ''
    allUrl = systemUrls?.allUrl || ''
    if (!httpUrl && !httpsUrl && !allUrl) return {}
  }

  const override = resolvedMode === PROXY_MODE_CUSTOM
  const existingHttps = firstEnvValue(currentEnv, ['HTTPS_PROXY', 'https_proxy'])
  const existingHttp = firstEnvValue(currentEnv, ['HTTP_PROXY', 'http_proxy'])
  const existingAll = firstEnvValue(currentEnv, ['ALL_PROXY', 'all_proxy'])

  const fragment = {}
  if (httpsUrl && (override || !existingHttps)) {
    fragment.HTTPS_PROXY = httpsUrl
    fragment.https_proxy = httpsUrl
  }
  if (httpUrl && (override || !existingHttp)) {
    fragment.HTTP_PROXY = httpUrl
    fragment.http_proxy = httpUrl
  }
  if (allUrl && (override || !existingAll)) {
    fragment.ALL_PROXY = allUrl
    fragment.all_proxy = allUrl
  }

  if (Object.keys(fragment).length > 0) {
    const noProxy = buildNoProxyValue(firstEnvValue(currentEnv, ['NO_PROXY', 'no_proxy']))
    fragment.NO_PROXY = noProxy
    fragment.no_proxy = noProxy
  }
  return fragment
}

/**
 * Read the live macOS system proxy. Thin (execs `scutil --proxy`). Non-mac or
 * any failure yields an empty descriptor — the caller then injects nothing.
 */
function readSystemProxy({ platform = process.platform, exec = execFileSync } = {}) {
  if (platform !== 'darwin') return parseScutilProxy('')
  try {
    const out = exec('scutil', ['--proxy'], { timeout: 3000, encoding: 'utf8', windowsHide: true })
    return parseScutilProxy(out)
  } catch {
    return parseScutilProxy('')
  }
}

/**
 * Resolve the proxy env fragment for a stored `{ mode, customUrl }` config.
 * Thin orchestrator: reads the system proxy only in AUTO mode, then delegates
 * the whole decision to the pure `buildProxyEnvFragment`.
 */
function resolveAgentProxyEnv({
  mode,
  customUrl,
  currentEnv = process.env,
  platform = process.platform,
  exec = execFileSync
} = {}) {
  const resolvedMode = normalizeProxyMode(mode)
  const systemUrls =
    resolvedMode === PROXY_MODE_AUTO
      ? systemProxyToUrls(readSystemProxy({ platform, exec }))
      : { httpUrl: '', httpsUrl: '', allUrl: '' }
  return buildProxyEnvFragment({ mode: resolvedMode, customUrl, systemUrls, currentEnv })
}

/**
 * A display-safe summary of the resolved proxy for the settings card. Pure.
 * Never surfaces credentials embedded in a URL (userinfo is stripped).
 */
function describeAgentProxy({ mode, customUrl, systemUrls } = {}) {
  const resolvedMode = normalizeProxyMode(mode)
  const strip = url => {
    if (!url) return ''
    try {
      const parsed = new URL(url)
      parsed.username = ''
      parsed.password = ''
      return parsed.href.replace(/\/+$/, '')
    } catch {
      return ''
    }
  }
  if (resolvedMode === PROXY_MODE_OFF) return { mode: resolvedMode, active: false, url: '' }
  if (resolvedMode === PROXY_MODE_CUSTOM) {
    const url = strip(normalizeCustomProxyUrl(customUrl))
    return { mode: resolvedMode, active: Boolean(url), url }
  }
  const url = strip(systemUrls?.httpsUrl || systemUrls?.httpUrl || systemUrls?.allUrl || '')
  return { mode: resolvedMode, active: Boolean(url), url }
}

module.exports = {
  NO_PROXY_WHITELIST,
  PROXY_MODE_AUTO,
  PROXY_MODE_CUSTOM,
  PROXY_MODE_OFF,
  PROXY_MODES,
  normalizeProxyMode,
  parseScutilProxy,
  systemProxyToUrls,
  normalizeCustomProxyUrl,
  buildNoProxyValue,
  buildProxyEnvFragment,
  readSystemProxy,
  resolveAgentProxyEnv,
  describeAgentProxy
}
