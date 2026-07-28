import type { ModelOptionProvider } from '@/types/hermes'

/**
 * hc-602 — "the model list collapsed" as a value the code can act on.
 *
 * The runtime builds the managed provider's row by probing the relay's live
 * `GET /v1/models` with `custom_providers[].api_key`. When that key has been
 * rotated out the probe 401s and the failure is SILENT: the row simply falls
 * back to the single model id config.yaml names, which is exactly what a user
 * reports as "其他模型不见了". Nothing in the response says "auth failed", so the
 * shape of the row IS the signal.
 *
 * Deliberately narrow, because the action it triggers is a network probe:
 *   - the managed row must be present (a BYOK / signed-out install never probes);
 *   - it must carry at most one model — a live catalog returns the whole relay
 *     directory, so one model means the fallback, not a small directory.
 * A row with zero models counts too: an unconfigured provider looks the same
 * from here and a probe is cheap, whereas leaving a dead key in place is not.
 */
export function managedCatalogCollapsed(managed: ModelOptionProvider | null | undefined): boolean {
  if (!managed) {
    return false
  }

  return (managed.models ?? []).length <= 1
}
