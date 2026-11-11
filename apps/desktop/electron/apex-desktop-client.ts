/**
 * Which APEX Desktop is asking (hc-1201): this build's version and platform,
 * sent with the requests whose answer depends on them, and handed to the
 * engine through main's environment so its own requests say the same.
 *
 * apex-nodes `openfilm_access` opens the editor to a whole plan only for a
 * Desktop that says it is 0.17.77 or later on mac-arm64; an account's own
 * override decides alone, whatever the build. A request without these headers
 * is an older Desktop, and the plan-wide opening does not reach it.
 *
 * Every sender reads them from here:
 * - openfilm-studio.ts `readOpenfilmAccess`: GET /tools/v1/check (the editor's answer);
 * - apex-platform-skills.ts via apex-platform-skills-sync.ts: GET /api/v1/desktop/platform-skills
 *   (the film-edit skill comes with that answer);
 * - the engine's apex_overlay/film_project.py `editor_on`: GET /tools/v1/check, from the
 *   environment variables below (openfilm-studio.ts `registerOpenfilmStudio` writes them into
 *   main's environment before any engine starts, and every engine inherits it).
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

export const DESKTOP_VERSION_HEADER = 'X-Apex-Desktop-Version'
export const DESKTOP_PLATFORM_HEADER = 'X-Apex-Desktop-Platform'
export const DESKTOP_VERSION_ENV = 'APEX_DESKTOP_VERSION'
export const DESKTOP_PLATFORM_ENV = 'APEX_DESKTOP_PLATFORM'

export interface DesktopClient {
  /** `mac-arm64`, `mac-x64` or `win-x64` (the runtime bundles' names), else `${platform}-${arch}`. */
  platform: string
  /** This build's version, e.g. `0.17.77`. */
  version: string
}

/** This build's platform as apex-nodes names it (`RUNTIME_VERSION_BUNDLE_PLATFORMS`). Pure. */
export function desktopPlatform(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `mac-${arch}`
  }

  if (platform === 'win32' && arch === 'x64') {
    return 'win-x64'
  }

  return `${platform}-${arch}`
}

/** This Desktop: the app's own version (`app.getVersion()`) and the platform it runs as. */
export function desktopClient(
  app: { getVersion: () => string },
  platform: string = process.platform,
  arch: string = process.arch
): DesktopClient {
  return { version: String(app.getVersion() ?? '').trim(), platform: desktopPlatform(platform, arch) }
}

/** The environment that carries `client` to the engine; a value that is empty is left out. */
export function desktopClientEnv(client: DesktopClient): Record<string, string> {
  const env: Record<string, string> = {}

  if (client.version) {
    env[DESKTOP_VERSION_ENV] = client.version
  }

  if (client.platform) {
    env[DESKTOP_PLATFORM_ENV] = client.platform
  }

  return env
}

/**
 * The headers that say which Desktop asks, read from `env` (main's own, once
 * `registerOpenfilmStudio` has written it): none when it says nothing, so the
 * request is what an older Desktop sends.
 */
export function desktopClientHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const headers: Record<string, string> = {}
  const version = String(env[DESKTOP_VERSION_ENV] ?? '').trim()
  const platform = String(env[DESKTOP_PLATFORM_ENV] ?? '').trim()

  if (version) {
    headers[DESKTOP_VERSION_HEADER] = version
  }

  if (platform) {
    headers[DESKTOP_PLATFORM_HEADER] = platform
  }

  return headers
}
