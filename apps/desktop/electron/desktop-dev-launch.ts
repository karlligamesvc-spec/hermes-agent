import path from 'node:path'

/**
 * A development launch (`electron .`, the e2e fixtures, local harnesses) must
 * not take the installed APEX's place in the OS (hc-1180).
 *
 * - `apexnodes://`: `app.setAsDefaultProtocolClient(scheme, executable, args)`
 *   ignores `executable` and `args` on macOS and registers the RUNNING bundle,
 *   which for a development launch is the stock Electron.app
 *   (`com.github.electron`). Every dev or e2e start on a Mac pointed APEX's
 *   links (the browser's "open APEX" after sign-in) at an empty Electron window
 *   until the installed APEX started again. On Windows `executable` and `args`
 *   do apply, so the link opens this checkout and breaks once the checkout
 *   moves. A development launch registers only with
 *   HERMES_DESKTOP_DEV_PROTOCOL=1, for deep-link work.
 * - macOS Dock: a development launch keeps Electron's own Dock icon, so its
 *   window is never mistaken for an installed APEX or a packaged test copy.
 *
 * "Development launch" is `process.defaultApp` (Electron started with an app
 * path on its command line), the signal main.ts already used to pick the
 * development registration. Packaged builds make exactly the calls they made
 * before.
 */

export const DEV_PROTOCOL_OPT_IN_ENV = 'HERMES_DESKTOP_DEV_PROTOCOL'

export const DEV_PROTOCOL_SKIPPED_LOG = `[deeplink] development launch: apexnodes:// stays with the installed APEX (set ${DEV_PROTOCOL_OPT_IN_ENV}=1 to claim it)`

export interface DesktopLaunchProcess {
  argv: readonly string[]
  defaultApp?: boolean
  env: Readonly<Record<string, string | undefined>>
  execPath: string
}

export type ApexProtocolPlan =
  | { developmentLaunch?: { entryScript: string; executable: string }; register: true }
  | { developmentLaunch?: undefined; register: false }

interface MacDock {
  setIcon: (icon: string) => void
}

export function planApexDesktopProtocol(launch: DesktopLaunchProcess): ApexProtocolPlan {
  if (!launch.defaultApp) {
    return { register: true }
  }

  if (launch.env[DEV_PROTOCOL_OPT_IN_ENV] !== '1') {
    return { register: false }
  }

  if (launch.argv.length < 2) {
    return { register: true }
  }

  // Include the entry script so Windows relaunches this app, not bare Electron.
  return {
    developmentLaunch: { entryScript: path.resolve(launch.argv[1]), executable: launch.execPath },
    register: true
  }
}

export function applyMacDockIcon(
  dock: MacDock | undefined,
  icon: string | undefined,
  launch: Pick<DesktopLaunchProcess, 'defaultApp'>
): void {
  if (!dock || !icon || launch.defaultApp) {
    return
  }

  dock.setIcon(icon)
}
