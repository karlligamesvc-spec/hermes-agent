/**
 * The renderer's view of the platform client config, plus this install's own
 * switches for the admin `desktop_features.<name>` flags.
 *
 * The admin client config is one global row (GET /api/v1/desktop/client-config
 * serves the active one, unauthenticated), so it cannot turn a feature on for a
 * few internal installs only. An install switch can: `APEXNODES_SINGLE_THREAD=1`
 * turns hc-1014's single-thread chat on for this install, `=0` keeps it off,
 * and unset leaves the decision to the platform. The payload itself stays as the
 * platform sent it; the switches ride beside it, so every other reader of
 * `desktop_features` is unaffected.
 */

/** Feature name (as in `desktop_features`) → the environment variable that switches it for one install. */
export const DESKTOP_FEATURE_ENV: Readonly<Record<string, string>> = {
  single_thread: 'APEXNODES_SINGLE_THREAD'
}

export interface ClientConfigStateLike {
  appliedVersion: number
  payload: Record<string, unknown> | null
  version: number
}

export interface RendererClientConfigState extends ClientConfigStateLike {
  /** Features this install switched on (true) or off (false); absent = the platform decides. */
  installSwitches: Record<string, boolean>
}

/** One switch value: true / false when set, null when the platform decides. */
export function envSwitch(raw: string | undefined): boolean | null {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()

  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true
  }

  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false
  }

  return null
}

export function desktopFeatureInstallSwitches(env: Record<string, string | undefined>): Record<string, boolean> {
  const switches: Record<string, boolean> = {}

  for (const [feature, name] of Object.entries(DESKTOP_FEATURE_ENV)) {
    const on = envSwitch(env?.[name])

    if (on !== null) {
      switches[feature] = on
    }
  }

  return switches
}

/** What `hermes:clientConfig:get` answers: the cached state as stored, and this install's switches. */
export function clientConfigForRenderer(
  state: ClientConfigStateLike,
  env: Record<string, string | undefined>
): RendererClientConfigState {
  return {
    version: state.version,
    payload: state.payload,
    appliedVersion: state.appliedVersion,
    installSwitches: desktopFeatureInstallSwitches(env)
  }
}
