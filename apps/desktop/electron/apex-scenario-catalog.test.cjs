'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  DEFAULT_TTL_MS,
  isFresh,
  loadScenarioCatalog,
  scenarioCatalogUrl
} = require('./apex-scenario-catalog.cjs')

const CATALOG = { enabled: true, version: 'hc552-v1', sections: [{ key: 'social', title: '社媒', items: [] }] }

test('scenarioCatalogUrl builds the /media path and tolerates trailing slashes', () => {
  assert.equal(scenarioCatalogUrl('https://api.apex-nodes.com'), 'https://api.apex-nodes.com/api/v1/media/scenario-catalog')
  assert.equal(scenarioCatalogUrl('https://api.apex-nodes.com/'), 'https://api.apex-nodes.com/api/v1/media/scenario-catalog')
  assert.equal(scenarioCatalogUrl(''), '')
  assert.equal(scenarioCatalogUrl(undefined), '')
})

test('isFresh honors the TTL window', () => {
  assert.equal(isFresh({ value: CATALOG, fetchedAt: 1000 }, 1000 + DEFAULT_TTL_MS - 1, DEFAULT_TTL_MS), true)
  assert.equal(isFresh({ value: CATALOG, fetchedAt: 1000 }, 1000 + DEFAULT_TTL_MS + 1, DEFAULT_TTL_MS), false)
  assert.equal(isFresh({}, 5000, DEFAULT_TTL_MS), false)
  assert.equal(isFresh({ value: null, fetchedAt: 5000 }, 5000, DEFAULT_TTL_MS), false)
})

test('loadScenarioCatalog fetches, caches, and serves the cache within TTL', async () => {
  let calls = 0
  const fetchJson = async (url, opts) => {
    calls += 1
    assert.equal(url, 'https://api.apex-nodes.com/api/v1/media/scenario-catalog')
    assert.equal(opts.bearer, 'relay-key')
    return CATALOG
  }
  const cache = {}

  const first = await loadScenarioCatalog({
    apiBase: 'https://api.apex-nodes.com',
    apiKey: 'relay-key',
    fetchJson,
    now: 1000,
    cache
  })
  assert.deepEqual(first, CATALOG)
  assert.equal(calls, 1)

  // A second call inside the TTL window is served from cache — no network.
  const second = await loadScenarioCatalog({
    apiBase: 'https://api.apex-nodes.com',
    apiKey: 'relay-key',
    fetchJson,
    now: 1000 + 60_000,
    cache
  })
  assert.deepEqual(second, CATALOG)
  assert.equal(calls, 1)
})

test('loadScenarioCatalog returns null when key/base/transport are missing', async () => {
  assert.equal(await loadScenarioCatalog({ apiBase: 'https://x', apiKey: '', fetchJson: async () => CATALOG }), null)
  assert.equal(await loadScenarioCatalog({ apiBase: '', apiKey: 'k', fetchJson: async () => CATALOG }), null)
  assert.equal(await loadScenarioCatalog({ apiBase: 'https://x', apiKey: 'k', fetchJson: undefined }), null)
})

test('loadScenarioCatalog fails open — a fetch error serves the stale cache, else null', async () => {
  const throwing = async () => {
    throw new Error('offline')
  }

  // No prior cache → null.
  assert.equal(
    await loadScenarioCatalog({ apiBase: 'https://x', apiKey: 'k', fetchJson: throwing, cache: {} }),
    null
  )

  // Prior cache → stale-served on error.
  const cache = { value: CATALOG, fetchedAt: 0 }
  const served = await loadScenarioCatalog({
    apiBase: 'https://x',
    apiKey: 'k',
    fetchJson: throwing,
    now: DEFAULT_TTL_MS + 1,
    cache
  })
  assert.deepEqual(served, CATALOG)
})
