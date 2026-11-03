import type { DesktopClientConfigState } from '@/global'

/**
 * The admin client config's per-feature switches (`desktop_features.<name>`),
 * read from the cached payload `hermesDesktop.clientConfig.get()` returns. Only a
 * literal `true` turns a feature on, so a missing or malformed config keeps it off.
 */
export function desktopFeatureOn(payload: unknown, name: string): boolean {
  const features =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { desktop_features?: unknown }).desktop_features
      : null

  return Boolean(
    features && typeof features === 'object' && !Array.isArray(features) && (features as Record<string, unknown>)[name] === true
  )
}

/**
 * hc-1127: hear about a config that lands after this window opened, which only a
 * launch that started with nothing cached ever sends. A store calls this before its
 * first read, so a config lands either before the read, which finds it, or after
 * this call, which hears it.
 */
export function onLateClientConfig(settle: (state: DesktopClientConfigState) => void): void {
  if (typeof window !== 'undefined') {
    window.hermesDesktop?.clientConfig?.onArrived?.(settle)
  }
}
