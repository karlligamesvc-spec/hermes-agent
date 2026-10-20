/**
 * apex-creator-profile.ts — hc-991 first-use creator intake (WP4 小白引导)
 *
 * The main-process leg of the three Start-page cards (what the user makes,
 * where they publish, what troubles them most). The cloud owns the answers;
 * this module reads and writes them with the stored login JWT (which never
 * reaches the renderer) and keeps the local agent's copy of the cloud's
 * 用户画像 segment in step, so every new local session carries the answers the
 * same way a cloud agent's system prompt does. Electron-free so it runs under
 * `vitest --project electron`, like apex-team.ts.
 *
 * Backend contract (apex-nodes `app/routers/creator_profile.py`):
 *   GET {API_BASE}/api/v1/account/creator-profile
 *   PUT {API_BASE}/api/v1/account/creator-profile   body: a patch (snake_case)
 *   Authorization: Bearer <login JWT>
 *   200 → { answers: { content_type, content_type_other, platforms, pain_point },
 *           intake: { completed, next_step, skipped }, prompt_segment: string | null }
 *   401 → session expired · 403 → installer-only account · 404 → a cloud from
 *   before this API · 422 → { detail: { code } } a patch the cloud refused
 *
 * Local copy: <HERMES_HOME>/apex/user-profile-prompt.md holds prompt_segment
 * verbatim, or is absent. The apex-overlay plugin's `apex.user-profile`
 * system-prompt section reads it when each new session starts
 * (apex_overlay/user_profile_prompt.py). It is removed whenever the signed-in
 * account changes or signs out, and a reply that comes back for an account
 * that is no longer signed in never writes it.
 */

import fs from 'node:fs'
import path from 'node:path'

import { managedAccountId } from './apex-account-boundary'

export const CREATOR_CONTENT_TYPES = ['product_review', 'knowledge', 'store_visit', 'drama', 'vlog', 'other'] as const
export const CREATOR_PLATFORMS = ['douyin', 'xiaohongshu', 'channels', 'kuaishou', 'bilibili'] as const
export const CREATOR_PAIN_POINTS = ['no_topic', 'no_script', 'no_editing', 'no_traffic', 'no_shooting'] as const
export const CREATOR_INTAKE_STEPS = ['content_type', 'platforms', 'pain_point'] as const

export type CreatorContentType = (typeof CREATOR_CONTENT_TYPES)[number]
export type CreatorPlatform = (typeof CREATOR_PLATFORMS)[number]
export type CreatorPainPoint = (typeof CREATOR_PAIN_POINTS)[number]
export type CreatorIntakeStep = (typeof CREATOR_INTAKE_STEPS)[number]

export interface CreatorProfileAnswers {
  contentType: CreatorContentType | null
  contentTypeOther: string | null
  painPoint: CreatorPainPoint | null
  platforms: CreatorPlatform[]
}

export interface CreatorProfileState {
  answers: CreatorProfileAnswers
  intake: { completed: boolean; nextStep: CreatorIntakeStep | null; skipped: CreatorIntakeStep[] }
}

/** A key that is present sets that answer (null or [] clears it); an absent key is left alone. */
export interface CreatorProfilePatch {
  contentType?: CreatorContentType | null
  contentTypeOther?: string | null
  painPoint?: CreatorPainPoint | null
  platforms?: CreatorPlatform[] | null
  skip?: CreatorIntakeStep[]
}

export type CreatorProfileRequest = { action: 'get' } | { action: 'save'; patch: CreatorProfilePatch }

export interface CreatorProfileResult {
  message?: 'FETCH_FAILED' | 'INVALID' | 'NOT_SIGNED_IN' | 'SESSION_EXPIRED'
  needsSignIn?: boolean
  ok: boolean
  /** null: this account has no intake (installer-only, or a cloud without the API). */
  profile: CreatorProfileState | null
}

/** What the shell lends these calls: the stored JWT, the API base and its authed JSON calls. */
export interface CreatorProfileDeps {
  accessToken: () => string
  apiBase: () => string
  getJson: (url: string, opts: { bearer: string }) => Promise<unknown>
  log: (line: string) => void
  postJson: (url: string, opts: { bearer: string; body: object; method?: 'PUT' }) => Promise<unknown>
}

const CREATOR_PROFILE_PATH = '/api/v1/account/creator-profile'
const PROMPT_DIR = 'apex'
const PROMPT_FILE = 'user-profile-prompt.md'
// The runtime's plugin prompt sections cap each section at 4,000 characters.
const PROMPT_MAX_CHARS = 4_000

export function creatorProfileUrl(apiBase: string): string {
  return `${String(apiBase || '').replace(/\/+$/, '')}${CREATOR_PROFILE_PATH}`
}

export function userProfilePromptPath(hermesHome: string): string {
  return path.join(hermesHome, PROMPT_DIR, PROMPT_FILE)
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

function subsetOf<T extends string>(values: readonly T[], value: unknown): T[] {
  const wanted = new Set(Array.isArray(value) ? value : [])

  return values.filter(item => wanted.has(item))
}

/** The cloud's reply as renderer state plus the segment, or null when it is malformed. */
export function parseCreatorProfile(
  body: unknown
): { promptSegment: string | null; state: CreatorProfileState } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const { answers, intake, prompt_segment: segment } = body as Record<string, unknown>

  if (!answers || typeof answers !== 'object' || !intake || typeof intake !== 'object') {
    return null
  }

  const a = answers as Record<string, unknown>
  const i = intake as Record<string, unknown>
  const contentType = oneOf(CREATOR_CONTENT_TYPES, a.content_type)
  const other = typeof a.content_type_other === 'string' ? a.content_type_other.trim() : ''

  return {
    promptSegment: typeof segment === 'string' && segment.trim() ? segment.trim() : null,
    state: {
      answers: {
        contentType: contentType === 'other' && !other ? null : contentType,
        contentTypeOther: contentType === 'other' && other ? other : null,
        painPoint: oneOf(CREATOR_PAIN_POINTS, a.pain_point),
        platforms: subsetOf(CREATOR_PLATFORMS, a.platforms)
      },
      intake: {
        completed: i.completed === true,
        nextStep: i.completed === true ? null : oneOf(CREATOR_INTAKE_STEPS, i.next_step),
        skipped: subsetOf(CREATOR_INTAKE_STEPS, i.skipped)
      }
    }
  }
}

/** The renderer's patch in the cloud's field names; keys the renderer did not send stay absent. */
export function toWirePatch(patch: CreatorProfilePatch | null | undefined): Record<string, unknown> {
  const source = patch && typeof patch === 'object' ? patch : {}
  const wire: Record<string, unknown> = {}

  if ('contentType' in source) {
    wire.content_type = source.contentType ?? null

    if (source.contentType === 'other') {
      wire.content_type_other = String(source.contentTypeOther ?? '').trim()
    }
  }

  if ('platforms' in source) {
    wire.platforms = source.platforms ?? []
  }

  if ('painPoint' in source) {
    wire.pain_point = source.painPoint ?? null
  }

  if (Array.isArray(source.skip) && source.skip.length > 0) {
    wire.skip = source.skip
  }

  return wire
}

/** Write the segment for the local agent, or remove the file when there is none. Never throws. */
export function syncUserProfilePrompt(hermesHome: string, segment: string | null, log: (line: string) => void): void {
  const target = userProfilePromptPath(hermesHome)

  try {
    if (!segment || segment.length > PROMPT_MAX_CHARS) {
      fs.rmSync(target, { force: true })

      return
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${segment}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, target)
  } catch (error) {
    log(`[creator-profile] local prompt write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The account changed or signed out: the previous account's answers leave the local agent. */
export function clearUserProfilePrompt(hermesHome: string): void {
  try {
    fs.rmSync(userProfilePromptPath(hermesHome), { force: true })
  } catch {
    // Best-effort: a stale file is replaced by the next account's first read.
  }
}

function statusCodeOf(error: unknown): number | undefined {
  const code = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined

  return typeof code === 'number' ? code : undefined
}

/** One read or write for the signed-in account. Never throws: the Start page must open regardless. */
export async function creatorProfileRequest(
  deps: CreatorProfileDeps,
  hermesHome: string,
  request: CreatorProfileRequest | null | undefined
): Promise<CreatorProfileResult> {
  const token = String(deps.accessToken() || '').trim()

  if (!token) {
    return { message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false, profile: null }
  }

  const owner = managedAccountId(token)
  const stillOwner = () => managedAccountId(String(deps.accessToken() || '').trim()) === owner
  const url = creatorProfileUrl(deps.apiBase())

  try {
    const body =
      request?.action === 'save'
        ? await deps.postJson(url, { bearer: token, body: toWirePatch(request.patch), method: 'PUT' })
        : await deps.getJson(url, { bearer: token })

    const parsed = parseCreatorProfile(body)

    if (!parsed) {
      deps.log('[creator-profile] unreadable reply')

      return { message: 'FETCH_FAILED', ok: false, profile: null }
    }

    // A reply for an account that is no longer signed in never reaches this one's agent.
    if (!stillOwner()) {
      return { message: 'FETCH_FAILED', ok: false, profile: null }
    }

    syncUserProfilePrompt(hermesHome, parsed.promptSegment, deps.log)

    return { ok: true, profile: parsed.state }
  } catch (error) {
    const code = statusCodeOf(error)

    if (code === 401) {
      return { message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, profile: null }
    }

    if (code === 403 || code === 404) {
      if (stillOwner()) {
        clearUserProfilePrompt(hermesHome)
      }

      return { ok: true, profile: null }
    }

    if (code === 422) {
      return { message: 'INVALID', ok: false, profile: null }
    }

    deps.log(`[creator-profile] request failed: ${error instanceof Error ? error.message : String(error)}`)

    return { message: 'FETCH_FAILED', ok: false, profile: null }
  }
}
