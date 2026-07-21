import { useQuery } from '@tanstack/react-query'

import { FALLBACK_CATALOG, normalizeScenarioCatalog, type ScenarioCatalog } from './catalog'

// Match the cloud master's TTL (hc-552 SCENARIO_MENU_TTL_SECONDS default 300s):
// the catalog is downloadable-adjustable but not hot, so a 5-minute cache keeps
// the ✦ menu / shelf snappy without hammering the endpoint.
const SCENARIO_CATALOG_TTL_MS = 5 * 60_000

/** Best-effort fetch of the shared scenario catalog through the main-process
 *  bridge (agent-key auth lives in main; no secret crosses to the renderer).
 *  Any failure — older main without the bridge, offline, 401, malformed body —
 *  resolves to the built-in fallback so the UI never white-screens. */
async function fetchScenarioCatalog(): Promise<ScenarioCatalog> {
  const bridge = typeof window !== 'undefined' ? window.hermesDesktop?.scenarioCatalog : undefined

  if (!bridge?.get) {
    return FALLBACK_CATALOG
  }

  try {
    const raw = await bridge.get()

    return normalizeScenarioCatalog(raw) ?? FALLBACK_CATALOG
  } catch {
    return FALLBACK_CATALOG
  }
}

/** The scenario catalog, always resolved to a usable value (fallback until the
 *  live fetch lands, and forever if it never does). */
export function useScenarioCatalog(): ScenarioCatalog {
  const { data } = useQuery({
    queryKey: ['scenario-catalog'],
    queryFn: fetchScenarioCatalog,
    staleTime: SCENARIO_CATALOG_TTL_MS,
    gcTime: Number.POSITIVE_INFINITY,
    // The fallback is itself a valid catalog: render it immediately so the
    // zero-state shelf paints on first frame instead of flashing empty.
    placeholderData: FALLBACK_CATALOG,
    retry: false
  })

  return data ?? FALLBACK_CATALOG
}
