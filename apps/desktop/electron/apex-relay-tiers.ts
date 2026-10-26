/**
 * apex-relay-tiers.ts — the relay's model listing as main reads it, and the
 * tiers it grants this account (hc-1072).
 *
 * `GET {base_url}/models` is the SAME listing the runtime's model picker calls
 * to build its live "APEX-NODES.COM" group. The relay answers it with exactly
 * the tier aliases the account's plan grants and has open right now (apex-nodes
 * api-relay `list_models`: enabled ∩ allowed_models ∩ desktop_public_models;
 * a closed gated tier is already dropped from allowed_models). Main probes it at
 * boot and on demand for the relay-key self-heal (hc-595) and the model menu's
 * catalog state (hc-512); only the status code mattered there. hc-1072 also
 * keeps the ids, so the single-thread config heal can drop a tier the plan no
 * longer grants (apex-model-tiers.ts healManagedModelTier).
 *
 * Electron-free: main passes `electron.net` in, tests pass a fake.
 */

import { MODEL_TIER_ALIASES } from './apex-model-tiers'

/** The part of `electron.net` the probe uses. */
export interface RelayNet {
  request(options: { method: string; redirect: 'follow'; url: string }): RelayRequest
}

interface RelayRequest {
  abort(): void
  end(): void
  on(event: 'error', listener: () => void): unknown
  on(event: 'response', listener: (response: RelayResponse) => void): unknown
  setHeader(name: string, value: string): void
}

interface RelayResponse {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end', listener: () => void): unknown
  statusCode?: number
}

export interface RelayModelsProbe {
  ok: boolean
  /** The listed model ids on a 2xx JSON answer, else null. */
  models: null | string[]
  statusCode: number
}

// A listing is a few hundred bytes; anything this large is not one.
const MAX_LISTING_BYTES = 256 * 1024

/** The `data[].id` strings of an OpenAI-style model listing, or null. */
export function relayModelIds(body: string): null | string[] {
  try {
    const data = (JSON.parse(body) as { data?: unknown })?.data

    if (!Array.isArray(data)) {
      return null
    }

    return data.flatMap(item => {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : null

      return typeof id === 'string' && id.trim() ? [id.trim()] : []
    })
  } catch {
    return null
  }
}

// Probe the relay's OpenAI-compatible model listing with a Bearer relay key.
// 401/403 means the stored relay key is dead (rotated out) and the picker list
// has collapsed; that is the self-heal trigger. On a timeout / network error it
// resolves { ok:false, statusCode:0 } (NOT an auth failure — we must not
// re-provision on a transient outage). electron.net transport + explicit
// timeout, GET + no body.
//
// base_url already ends at the relay `/v1` segment (see DEFAULT_RELAY_BASE_URL),
// so the listing path is `${base_url}/models`.
export function fetchRelayModels(
  net: RelayNet,
  baseUrl: unknown,
  key: unknown,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}
): Promise<RelayModelsProbe> {
  return new Promise(resolve => {
    const failed = { models: null, ok: false, statusCode: 0 }

    const base = String(baseUrl || '')
      .trim()
      .replace(/\/+$/, '')

    const relayKey = String(key || '').trim()

    if (!base || !relayKey) {
      resolve(failed)

      return
    }

    const url = `${base}/models`
    let parsed: URL

    try {
      parsed = new URL(url)
    } catch {
      resolve(failed)

      return
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve(failed)

      return
    }

    let settled = false

    const done = (result: RelayModelsProbe) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const request = net.request({ method: 'GET', url, redirect: 'follow' })
    request.setHeader('Authorization', `Bearer ${relayKey}`)
    request.setHeader('Accept', 'application/json')

    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        // already finished
      }

      done(failed)
    }, timeoutMs)

    request.on('response', res => {
      const statusCode = res.statusCode || 0
      const ok = statusCode >= 200 && statusCode < 400
      let body = ''

      // Read to the end either way so the socket can be reused/closed cleanly.
      res.on('data', chunk => {
        if (body.length < MAX_LISTING_BYTES) {
          body += String(chunk)
        }
      })
      res.on('end', () => done({ models: ok ? relayModelIds(body) : null, ok, statusCode }))
    })
    request.on('error', () => done(failed))
    request.end()
  })
}

/**
 * The tier aliases the relay last listed for a relay key. Keyed by the key so a
 * listing read for one account can never cap another's model after a sign-in
 * switch or a key rotation: until the new key's own listing arrives the answer
 * is null (unknown), and the heal keeps the user's tier — the relay answers a
 * tier it does not grant on the plan default anyway.
 */
export class RelayTierMemo {
  private key = ''
  private tiers: null | string[] = null

  /** The tiers granted to `key`, or null while unknown (not read yet, offline,
   *  an older relay that lists no tier alias). */
  of(key: unknown): null | string[] {
    return this.tiers && String(key || '').trim() === this.key ? [...this.tiers] : null
  }

  /** Record a probe's answer; true when it names tiers for `key` that differ
   *  from the ones known before (the moment a re-heal can change something). */
  note(key: unknown, probe: Pick<RelayModelsProbe, 'models' | 'ok'>): boolean {
    const relayKey = String(key || '').trim()

    if (!relayKey || !probe.ok || !probe.models) {
      return false
    }

    const listed = new Set(probe.models.map(model => model.toLowerCase()))
    const tiers = MODEL_TIER_ALIASES.filter(alias => listed.has(alias))
    const before = this.of(relayKey)

    this.key = relayKey
    this.tiers = tiers.length > 0 ? tiers : null

    return tiers.length > 0 && before?.join() !== tiers.join()
  }
}
