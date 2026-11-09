// hc-1200: the only version an update surface shows is the APEX app's. Engine
// versions are internal pins whose calver reads as a date ("引擎 2026.10.13"),
// so no copy takes one; support reads them from desktop.log.

/** `0.17.75` → `v0.17.75`; a missing version reads as an empty string. */
export function displayAppVersion(raw: string | null | undefined): string {
  if (!raw) {
    return ''
  }

  return raw.startsWith('v') ? raw : `v${raw}`
}
