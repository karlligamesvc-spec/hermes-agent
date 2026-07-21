'use strict'

// hc-554 — desktop scenario catalog fetch (main-process leg).
//
// The renderer's scenario shelf + ✦ menu read the shared catalog through the
// `hermes:scenarioCatalog:get` IPC. The catalog is the same one the hc-552 IM
// text-tree plugin consumes: `GET /api/v1/media/scenario-catalog`, authenticated
// with the agent API key (the endpoint accepts `Authorization: Bearer <key>`),
// TTL-cached. The signed-in user's ApexNodes relay key is that agent key.
//
// Contract, mirroring the fail-open discipline of the cloud plugin (hc-552):
//   - Never throws. Any failure (no key/base/transport, network, 4xx, malformed
//     body) resolves to the last-known-good catalog, or null when nothing was
//     ever fetched — the renderer then falls back to its built-in catalog.
//   - TTL-cached in a caller-owned object so a menu open doesn't hit the network
//     on every click.
//
// Kept dependency-injected + side-effect-free (the transport, clock, and cache
// are passed in) so it unit-tests without Electron — same shape as
// apex-platform-plugins.cjs.

const SCENARIO_CATALOG_PATH = '/api/v1/media/scenario-catalog'
const DEFAULT_TTL_MS = 5 * 60 * 1000

function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
}

/** The catalog URL for an apiBase, or '' when the base is missing/blank. */
function scenarioCatalogUrl(apiBase) {
  const base = trimTrailingSlash(apiBase)

  return base ? `${base}${SCENARIO_CATALOG_PATH}` : ''
}

/** A cache entry is fresh when it holds a value fetched within the TTL window. */
function isFresh(cache, now, ttlMs) {
  return Boolean(cache && cache.value != null && now - cache.fetchedAt < ttlMs)
}

/**
 * Resolve the scenario catalog — from the TTL cache when fresh, otherwise via
 * an authed GET. Never rejects; returns the catalog object, the stale cached
 * value, or null.
 *
 * @param {object} opts
 * @param {string} opts.apiBase master base (e.g. https://api.apex-nodes.com)
 * @param {string} opts.apiKey agent API key (the managed relay key)
 * @param {(url: string, options?: object) => Promise<any>} opts.fetchJson authed JSON GET; called as fetchJson(url, { bearer })
 * @param {number} [opts.now] current epoch ms (injectable for tests)
 * @param {number} [opts.ttlMs] cache TTL
 * @param {{ value?: any, fetchedAt?: number }} [opts.cache] caller-owned cache object (mutated in place)
 * @param {(message: string) => void} [opts.log]
 */
async function loadScenarioCatalog({
  apiBase,
  apiKey,
  fetchJson,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  cache = {},
  log = () => {}
} = {}) {
  if (isFresh(cache, now, ttlMs)) {
    return cache.value
  }

  const url = scenarioCatalogUrl(apiBase)

  if (!url || !apiKey || typeof fetchJson !== 'function') {
    // Missing base/key/transport — serve last-known-good if we have one, else
    // null so the renderer uses its built-in fallback.
    return cache.value ?? null
  }

  try {
    const body = await fetchJson(url, { bearer: apiKey })

    if (body && typeof body === 'object') {
      cache.value = body
      cache.fetchedAt = now

      return body
    }

    // A non-object 2xx (empty/HTML-ish) isn't a usable catalog; keep any prior.
    return cache.value ?? null
  } catch (error) {
    log(`[scenario-catalog] fetch failed: ${error && error.message}`)

    // Fail-open: a live error must not blank the shelf — serve the last catalog.
    return cache.value ?? null
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  SCENARIO_CATALOG_PATH,
  isFresh,
  loadScenarioCatalog,
  scenarioCatalogUrl
}
