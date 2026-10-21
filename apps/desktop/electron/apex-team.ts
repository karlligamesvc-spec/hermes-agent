/**
 * apex-team.ts — hc-971
 *
 * The account menu shows the light team (hc-955) the signed-in APEX account
 * belongs to. The cloud is the only authority on membership, so this module
 * just reads it with the stored login JWT and hands the renderer a small,
 * validated summary; the JWT never crosses to the renderer. Electron-free so it
 * runs under `vitest --project electron`, like apex-announcements.ts.
 *
 * Backend contract (apex-nodes `app/routers/teams.py`):
 *   GET {API_BASE}/api/v1/teams/me
 *   Authorization: Bearer <login JWT>
 *   200 → { team: null } | { team: { name, status: 'pending' | 'active', is_admin, ... } }
 *   403 → a non-workbench account (installer only): it cannot be on a team
 *   404 → a cloud from before teams existed
 *
 * Display only: the menu never manages the team (that is the web console's job)
 * and never shows a team it cannot confirm. Any failure reads as "no team".
 */

export interface DesktopTeamSummary {
  isAdmin: boolean
  name: string
  status: 'active' | 'pending'
}

export interface DesktopTeamResult {
  message?: 'FETCH_FAILED' | 'NOT_SIGNED_IN' | 'SESSION_EXPIRED'
  needsSignIn?: boolean
  ok: boolean
  team: DesktopTeamSummary | null
}

/** What the shell lends this read: the stored JWT, the API base and its authed GET. */
export interface AccountReadDeps {
  accessToken: () => string
  apiBase: () => string
  getJson: (url: string, opts: { bearer: string }) => Promise<unknown>
  log: (line: string) => void
}

const TEAM_ME_PATH = '/api/v1/teams/me'

export function teamMeUrl(apiBase: string): string {
  return `${String(apiBase || '').replace(/\/+$/, '')}${TEAM_ME_PATH}`
}

/** The team the response names, or null for no team or anything malformed. */
export function parseTeamOverview(body: unknown): DesktopTeamSummary | null {
  const team = body && typeof body === 'object' ? (body as { team?: unknown }).team : null

  if (!team || typeof team !== 'object' || Array.isArray(team)) {
    return null
  }

  const { is_admin: isAdmin, name, status } = team as Record<string, unknown>
  const label = typeof name === 'string' ? name.trim() : ''

  // A closed team has no members left, so only these two can come back.
  if (!label || (status !== 'active' && status !== 'pending')) {
    return null
  }

  return { isAdmin: isAdmin === true, name: label, status }
}

function statusCodeOf(error: unknown): number | undefined {
  const code = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined

  return typeof code === 'number' ? code : undefined
}

/** Never throws: the account menu must open whatever the network does. */
export async function fetchMyTeam(deps: AccountReadDeps): Promise<DesktopTeamResult> {
  const token = String(deps.accessToken() || '').trim()

  if (!token) {
    return { message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false, team: null }
  }

  try {
    return { ok: true, team: parseTeamOverview(await deps.getJson(teamMeUrl(deps.apiBase()), { bearer: token })) }
  } catch (error) {
    const code = statusCodeOf(error)

    if (code === 401) {
      return { message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, team: null }
    }

    if (code === 403 || code === 404) {
      return { ok: true, team: null }
    }

    deps.log(`[team] fetch failed: ${error instanceof Error ? error.message : String(error)}`)

    return { message: 'FETCH_FAILED', ok: false, team: null }
  }
}
