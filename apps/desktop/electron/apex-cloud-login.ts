/**
 * apex-cloud-login.ts — hc-1073: does the cloud still accept the stored login JWT?
 *
 * Desktop holds two credentials. Chat goes through the relay (Agent) key; every
 * account call goes through the login JWT: platform skills and plugins, the
 * Feishu credential, 更新日志, team, creator profile, tips, 今日点子, memory
 * ledger, plan usage, analysis, the workflow domain, IM entry, provision-key and
 * the daemon register. When the JWT dies and the relay key does not, chat keeps
 * working while skills and plugins stay on the last installed version, and the
 * only trace is a log line (one account: 10-16 → 10-26, skills stuck on 10-09).
 *
 * main.ts's JWT transports report every HTTP answer here. A 401 to the stored
 * JWT marks it rejected; any 2xx to it clears that; the renderer shows the
 * 「登录已失效」 card in between (store/cloud-login.ts). Only a 401 to a request
 * that carried the CURRENT stored JWT counts:
 *   - a network error, timeout or 5xx says nothing about the login (no status
 *     reaches here, or it is not 401); callers keep their installed set and
 *     retry on the next boot, as before;
 *   - the relay key and the daemon token travel the same transports as other
 *     bearers, and their 401s belong to other recovery paths;
 *   - a late 401 for a JWT the user has since replaced is stale.
 * The rejection is tied to the token it was seen on, so signing in again (a new
 * token) clears it without an explicit reset.
 */

export const CLOUD_LOGIN_CHANNEL = 'hermes:managed:cloud-login'

export interface CloudLoginState {
  /** The cloud answered 401 to the JWT that is stored right now. */
  rejected: boolean
  /** When that first 401 arrived (ms epoch), null while not rejected. */
  since: null | number
}

interface CloudLoginWindow {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: CloudLoginState) => void }
}

export interface CloudLoginDeps {
  /** The stored login JWT, '' when there is none (signed out, env-key installs). */
  currentToken: () => string
  log?: (message: string) => void
  now?: () => number
  windows: () => CloudLoginWindow[]
}

export interface CloudLoginHealth {
  /** A JWT transport got an HTTP error status; returns it unchanged for the transport's own use. */
  noteFailure: (bearer: unknown, statusCode: number) => number
  /** A JWT transport got a 2xx. */
  noteSuccess: (bearer: unknown) => void
  snapshot: () => CloudLoginState
}

interface IpcHandleRegistry {
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void
}

export function createCloudLoginHealth({ currentToken, log = () => {}, now = Date.now, windows }: CloudLoginDeps): CloudLoginHealth {
  let rejectedToken = ''
  let since: null | number = null

  const snapshot = (): CloudLoginState => {
    const rejected = rejectedToken !== '' && rejectedToken === currentToken()

    return { rejected, since: rejected ? since : null }
  }

  const publish = () => {
    const state = snapshot()

    for (const win of windows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CLOUD_LOGIN_CHANNEL, state)
      }
    }
  }

  // The bearer a request carried is the stored JWT, and there is one.
  const isStoredToken = (bearer: unknown): boolean => {
    const token = currentToken()

    return token !== '' && String(bearer ?? '').trim() === token
  }

  return {
    noteFailure(bearer, statusCode) {
      const token = currentToken()

      if (statusCode === 401 && isStoredToken(bearer) && rejectedToken !== token) {
        rejectedToken = token
        since = now()
        log('[cloud-login] the cloud rejected the stored login JWT (401); asking for a new sign-in (hc-1073)')
        publish()
      }

      return statusCode
    },
    noteSuccess(bearer) {
      if (!rejectedToken || !isStoredToken(bearer)) {
        return
      }

      rejectedToken = ''
      since = null
      log('[cloud-login] the cloud accepts the stored login JWT again')
      publish()
    },
    snapshot
  }
}

/** Create the tracker and answer the renderer's `managed.cloudLogin()` read. */
export function registerCloudLoginHealth(ipcMain: IpcHandleRegistry, deps: CloudLoginDeps): CloudLoginHealth {
  const health = createCloudLoginHealth(deps)
  ipcMain.handle('hermes:managed:cloudLogin', () => health.snapshot())

  return health
}
