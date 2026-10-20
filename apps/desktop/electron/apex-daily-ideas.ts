/**
 * apex-daily-ideas.ts — hc-995 今日点子 (WP4 小白引导)
 *
 * The Start page shows three ideas the signed-in user can shoot today: what to
 * shoot, how, and why today (a hot list the cloud read this morning, a common
 * structure, or a video the user broke down). The cloud picks and words every
 * card; this module reads them and sends 开做 / 不喜欢 back with the stored
 * login JWT, which never reaches the renderer. Electron-free so it runs under
 * `vitest --project electron`, like apex-team.ts.
 *
 * Backend contract (apex-nodes `app/routers/daily_ideas.py`):
 *   GET  {API_BASE}/api/v1/account/daily-ideas?page=N
 *   200 → { enabled: false, day, cards: [] }
 *       | { enabled: true, day, bucket, profile: { summary, complete }, cards: [card],
 *           pending, page, more }
 *     card: { id, kind: hot|structure|own, title, how, hook, why,
 *             source: { label, observed_at, url }, no_face, low_edit, started, start_prompt }
 *   POST {API_BASE}/api/v1/account/daily-ideas/feedback
 *        body { idea_id, action: start|dislike, reason?: not_my_direction|too_hard|skip_trend }
 *   200 → { enabled, ok } · 401 session expired · 403 installer-only account ·
 *   404 a cloud from before this API · 422 a request the cloud refused
 *
 * The switch: the platform turns the section on through the admin client config
 * (`desktop_features.daily_ideas`, read by the renderer and passed in as
 * `platformOn`); APEXNODES_DAILY_IDEAS=1/0 in the environment wins for one
 * install (testers). Off means no request at all. The cloud has its own switch
 * on top (`enabled: false`).
 */

export const DAILY_IDEA_KINDS = ['hot', 'structure', 'own'] as const
export const DAILY_IDEA_DISLIKE_REASONS = ['not_my_direction', 'too_hard', 'skip_trend'] as const

export type DailyIdeaKind = (typeof DAILY_IDEA_KINDS)[number]
export type DailyIdeaDislikeReason = (typeof DAILY_IDEA_DISLIKE_REASONS)[number]

export interface DailyIdeaCard {
  hook: string
  how: string
  id: string
  kind: DailyIdeaKind
  lowEdit: boolean
  noFace: boolean
  source: { label: string; observedAt: string | null; url: string | null }
  started: boolean
  startPrompt: string
  title: string
  why: string
}

export interface DailyIdeasPage {
  cards: DailyIdeaCard[]
  day: string
  more: boolean
  page: number
  pending: boolean
  profile: { complete: boolean; summary: string }
}

export type DailyIdeasRequest =
  | { action: 'get'; page?: number; platformOn?: boolean }
  | { action: 'feedback'; ideaId: string; kind: 'dislike' | 'start'; platformOn?: boolean; reason?: DailyIdeaDislikeReason }

export interface DailyIdeasResult {
  /** false: the section stays hidden (switched off here or in the cloud, or no such API). */
  enabled: boolean
  message?: 'FETCH_FAILED' | 'INVALID' | 'NOT_SIGNED_IN' | 'SESSION_EXPIRED'
  needsSignIn?: boolean
  ok: boolean
  /** The page read; null for feedback and failures. */
  page: DailyIdeasPage | null
}

/** What the shell lends these calls: the stored JWT, the API base and its authed JSON calls. */
export interface DailyIdeasDeps {
  accessToken: () => string
  apiBase: () => string
  getJson: (url: string, opts: { bearer: string }) => Promise<unknown>
  log: (line: string) => void
  postJson: (url: string, opts: { bearer: string; body: object }) => Promise<unknown>
}

export const DAILY_IDEAS_ENV = 'APEXNODES_DAILY_IDEAS'

const DAILY_IDEAS_PATH = '/api/v1/account/daily-ideas'
const MAX_PAGE = 20

export function dailyIdeasUrl(apiBase: string, page = 0): string {
  return `${String(apiBase || '').replace(/\/+$/, '')}${DAILY_IDEAS_PATH}?page=${page}`
}

export function dailyIdeasFeedbackUrl(apiBase: string): string {
  return `${String(apiBase || '').replace(/\/+$/, '')}${DAILY_IDEAS_PATH}/feedback`
}

/** The env override: true / false when set, null when the platform decides. */
export function dailyIdeasEnvSwitch(env: Record<string, string | undefined>): boolean | null {
  const raw = String(env?.[DAILY_IDEAS_ENV] ?? '')
    .trim()
    .toLowerCase()

  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true
  }

  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false
  }

  return null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Only a web link is ever opened from a card. */
function webUrl(value: unknown): string | null {
  const raw = text(value)

  try {
    const parsed = new URL(raw)

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function parseCard(raw: unknown): DailyIdeaCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const card = raw as Record<string, unknown>
  const kind = DAILY_IDEA_KINDS.find(value => value === card.kind)
  const source = card.source && typeof card.source === 'object' ? (card.source as Record<string, unknown>) : {}
  const id = text(card.id)
  const title = text(card.title)
  const startPrompt = text(card.start_prompt)

  if (!kind || !id || id.length > 64 || !title || !startPrompt) {
    return null
  }

  return {
    hook: text(card.hook),
    how: text(card.how),
    id,
    kind,
    lowEdit: card.low_edit === true,
    noFace: card.no_face === true,
    source: { label: text(source.label), observedAt: text(source.observed_at) || null, url: webUrl(source.url) },
    started: card.started === true,
    startPrompt,
    title,
    why: text(card.why)
  }
}

/** The cloud's page, `disabled` when the cloud has the feature off, or null when malformed. */
export function parseDailyIdeas(body: unknown): DailyIdeasPage | 'disabled' | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const page = body as Record<string, unknown>

  if (page.enabled === false) {
    return 'disabled'
  }

  if (page.enabled !== true || !Array.isArray(page.cards)) {
    return null
  }

  const profile = page.profile && typeof page.profile === 'object' ? (page.profile as Record<string, unknown>) : {}
  const cards = page.cards.map(parseCard).filter((card): card is DailyIdeaCard => card !== null)

  return {
    cards: cards.filter((card, index) => cards.findIndex(other => other.id === card.id) === index),
    day: text(page.day),
    more: page.more === true,
    page: typeof page.page === 'number' && Number.isSafeInteger(page.page) ? page.page : 0,
    pending: page.pending === true,
    profile: { complete: profile.complete === true, summary: text(profile.summary) }
  }
}

function statusCodeOf(error: unknown): number | null {
  const code = (error as { statusCode?: unknown })?.statusCode

  if (typeof code === 'number') {
    return code
  }

  const match = /^(\d{3}):/.exec(String((error as Error)?.message ?? ''))

  return match ? Number(match[1]) : null
}

function wireFeedback(request: Extract<DailyIdeasRequest, { action: 'feedback' }>): object | null {
  const ideaId = text(request.ideaId)

  if (!ideaId || ideaId.length > 64 || (request.kind !== 'start' && request.kind !== 'dislike')) {
    return null
  }

  if (request.kind === 'start') {
    return { action: 'start', idea_id: ideaId }
  }

  const reason = DAILY_IDEA_DISLIKE_REASONS.find(value => value === request.reason)

  return reason ? { action: 'dislike', idea_id: ideaId, reason } : { action: 'dislike', idea_id: ideaId }
}

/** One read or one 开做 / 不喜欢 for the signed-in account. Never throws: the Start page opens regardless. */
export async function dailyIdeasRequest(
  deps: DailyIdeasDeps,
  env: Record<string, string | undefined>,
  request: DailyIdeasRequest | null | undefined
): Promise<DailyIdeasResult> {
  const enabled = dailyIdeasEnvSwitch(env) ?? request?.platformOn === true

  if (!enabled) {
    return { enabled: false, ok: true, page: null }
  }

  const bearer = String(deps.accessToken() || '').trim()

  if (!bearer) {
    return { enabled, message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false, page: null }
  }

  try {
    if (request?.action === 'feedback') {
      const body = wireFeedback(request)

      if (!body) {
        return { enabled, message: 'INVALID', ok: false, page: null }
      }

      const reply = await deps.postJson(dailyIdeasFeedbackUrl(deps.apiBase()), { bearer, body })
      const answered = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : {}

      return { enabled: answered.enabled !== false, ok: answered.ok === true, page: null }
    }

    const wanted = Math.min(Math.max(Math.trunc(Number(request?.page) || 0), 0), MAX_PAGE)
    const parsed = parseDailyIdeas(await deps.getJson(dailyIdeasUrl(deps.apiBase(), wanted), { bearer }))

    if (parsed === 'disabled') {
      return { enabled: false, ok: true, page: null }
    }

    if (!parsed) {
      deps.log('[daily-ideas] unreadable reply')

      return { enabled, message: 'INVALID', ok: false, page: null }
    }

    return { enabled, ok: true, page: parsed }
  } catch (error) {
    const code = statusCodeOf(error)

    if (code === 401) {
      return { enabled, message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, page: null }
    }

    // An installer-only account, or a cloud from before this API: no section.
    if (code === 403 || code === 404) {
      return { enabled: false, ok: true, page: null }
    }

    deps.log(`[daily-ideas] request failed (${code ?? 'network'})`)

    return { enabled, message: 'FETCH_FAILED', ok: false, page: null }
  }
}
