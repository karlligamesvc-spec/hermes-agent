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
