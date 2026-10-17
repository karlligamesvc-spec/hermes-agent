import http from 'node:http'
import https from 'node:https'

import type { resolveLatestRuntimePin } from './apex-runtime-latest'

type RuntimePin = NonNullable<Awaited<ReturnType<typeof resolveLatestRuntimePin>>>

interface RuntimeUpdateApplyDependencies {
  updatesAllowed: () => boolean
  resolveLatest: () => Promise<RuntimePin | null>
  applyResolved: (pin: RuntimePin) => Promise<unknown>
}

/** A frozen continuation may apply only the target it already confirmed. */
export async function applyRuntimeUpdateToLatest(
  expectedTarget: unknown,
  dependencies: RuntimeUpdateApplyDependencies
) {
  if (!dependencies.updatesAllowed()) {
    return { ok: false, error: 'diagnostic-trial-updates-disabled' }
  }

  let pin: RuntimePin | null

  try {
    pin = await dependencies.resolveLatest()
  } catch (error: any) {
    return { ok: false, error: (error && error.message) || String(error) }
  }

  if (!pin) {
    return { ok: false, error: 'no_admin_latest_available' }
  }

  if (expectedTarget != null) {
    const expected = expectedTarget as { expectedKey?: unknown; expectedVersion?: unknown }
    const key = typeof expected.expectedKey === 'string' ? expected.expectedKey.trim() : ''
    const version = typeof expected.expectedVersion === 'string' ? expected.expectedVersion.trim() : ''

    const invalid =
      typeof expectedTarget !== 'object' ||
      Array.isArray(expectedTarget) ||
      (expected.expectedKey != null && !key) ||
      (expected.expectedVersion != null && !version)

    if (invalid || (!key && !version) || (key && key !== pin.key) || (version && version !== pin.version)) {
      return { ok: false, error: 'runtime_target_changed', latest: { key: pin.key, version: pin.version } }
    }
  }

  // Bundle switches, marker writes and durable overrides are all downstream of this gate.
  return dependencies.applyResolved(pin)
}

// Best-effort reachability probe for an update artifact (the COS source tarball)
// BEFORE we retarget the install pin and re-run bootstrap. This is the
// don't-brick guard: install.sh's CN path deletes INSTALL_DIR if the new tarball
// extract fails, so confirming the object actually exists first keeps a working
// install from being torn down for a 404. Resolves true on a 2xx/3xx HEAD,
// false on 4xx/5xx or a network error. Never throws. A missing URL resolves
// true (the non-CN git-clone path doesn't use COS and verifies via git itself).
export function isUpdateArtifactReachable(url, { timeoutMs = 8000 }: any = {}) {
  return new Promise(resolve => {
    const clean = String(url || '').trim()

    if (!clean) {
      resolve(true)

      return
    }

    let parsed

    try {
      parsed = new URL(clean)
    } catch {
      resolve(false)

      return
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve(false)

      return
    }

    const client = parsed.protocol === 'https:' ? https : http
    let settled = false

    const done = value => {
      if (settled) {
        return
      }

      settled = true
      resolve(value)
    }

    const req = client.request(parsed, { method: 'HEAD' }, res => {
      const code = res.statusCode || 0
      res.resume() // drain
      done(code >= 200 && code < 400)
    })

    req.on('error', () => done(false))
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy()
      } catch {
        void 0
      }

      done(false)
    })
    req.end()
  })
}
