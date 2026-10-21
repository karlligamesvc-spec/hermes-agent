/**
 * apex-creator-tips.ts — hc-995 creator tips (WP4 小白引导)
 *
 * While a step of a task runs, the process area says one line of creator
 * know-how tied to that step: 「识别语音」 → 「开头 3 秒决定完播……」. The cloud owns
 * the catalog; this module reads it and hands the renderer a validated list.
 * Which tip shows when, and the device's seen/daily ledger, live in the
 * renderer (src/store/creator-tips.ts). Electron-free so it runs under
 * `vitest --project electron`, like apex-team.ts.
 *
 * Backend contract (apex-nodes `app/routers/desktop_tips.py`):
 *   GET {API_BASE}/api/v1/desktop/tips[?known_hash=<hash>]
 *   200 → { schema: 'creator-tips/1', hash, tips: [{ id, steps: [tool name], text: { zh, en } }] }
 *       | { hash, unchanged: true }   (when known_hash is current)
 *   404 → a cloud from before tips existed
 * The catalog is the same for everyone and holds no account data; the login
 * JWT rides along only because the shell's GET helper is the authed one.
 *
 * The switch: the platform turns tips on for every install through the admin
 * client config (`desktop_features.creator_tips`, read by the renderer and
 * passed in as `platformOn`); APEXNODES_CREATOR_TIPS=1/0 in the environment wins
 * for one install (testers). Off means no request at all.
 */

export interface CreatorTip {
  id: string
  steps: string[]
  text: { en: string; zh: string }
}

export interface CreatorTipsRequest {
  /** The admin client config's `desktop_features.creator_tips`, as the renderer read it. */
  platformOn?: boolean
}

export interface CreatorTipsResult {
  enabled: boolean
  message?: 'FETCH_FAILED' | 'INVALID' | 'NOT_SIGNED_IN'
  ok: boolean
  tips: CreatorTip[]
}

/** What the shell lends this read: the stored JWT, the API base and its authed GET. */
export interface CreatorTipsDeps {
  accessToken: () => string
  apiBase: () => string
  getJson: (url: string, opts: { bearer: string }) => Promise<unknown>
  log: (line: string) => void
}

/** The last catalog this run fetched, so a repeat read sends `known_hash`. */
export interface CreatorTipsCache {
  hash: string
  tips: CreatorTip[]
}

export const CREATOR_TIPS_ENV = 'APEXNODES_CREATOR_TIPS'

const CREATOR_TIPS_PATH = '/api/v1/desktop/tips'
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const STEP_PATTERN = /^[a-z0-9_]+$/

export function creatorTipsUrl(apiBase: string, knownHash = ''): string {
  const base = `${String(apiBase || '').replace(/\/+$/, '')}${CREATOR_TIPS_PATH}`

  return knownHash ? `${base}?known_hash=${encodeURIComponent(knownHash)}` : base
}

/** The env override: true / false when set, null when the platform decides. */
export function creatorTipsEnvSwitch(env: Record<string, string | undefined>): boolean | null {
  const raw = String(env?.[CREATOR_TIPS_ENV] ?? '')
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

function parseTip(raw: unknown): CreatorTip | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const { id, steps, text } = raw as Record<string, unknown>

  if (typeof id !== 'string' || !ID_PATTERN.test(id) || !Array.isArray(steps) || !text || typeof text !== 'object') {
    return null
  }

  const stepNames = steps.filter((step): step is string => typeof step === 'string' && STEP_PATTERN.test(step))
  const { en, zh } = text as Record<string, unknown>

  if (!stepNames.length || typeof zh !== 'string' || !zh.trim() || typeof en !== 'string' || !en.trim()) {
    return null
  }

  return { id, steps: stepNames, text: { en: en.trim(), zh: zh.trim() } }
}

/**
 * The cloud's reply: the catalog, `unchanged` when the client's hash is still
 * current, or null when it is malformed. Tips that do not parse are dropped one
 * by one; a reply with none left that parse is malformed.
 */
export function parseCreatorTips(body: unknown): CreatorTipsCache | { hash: string; unchanged: true } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const { hash, tips, unchanged } = body as Record<string, unknown>

  if (typeof hash !== 'string' || !hash) {
    return null
  }

  if (unchanged === true) {
    return { hash, unchanged: true }
  }

  if (!Array.isArray(tips)) {
    return null
  }

  const parsed = tips.map(parseTip).filter((tip): tip is CreatorTip => tip !== null)
  const ids = new Set(parsed.map(tip => tip.id))

  return parsed.length && ids.size === parsed.length ? { hash, tips: parsed } : null
}

function statusOf(error: unknown): number | null {
  const status = (error as { statusCode?: unknown })?.statusCode

  if (typeof status === 'number') {
    return status
  }

  const match = /^(\d{3}):/.exec(String((error as Error)?.message ?? ''))

  return match ? Number(match[1]) : null
}

/** Read the catalog when tips are on; on any failure, keep what this run already had. */
export async function fetchCreatorTips(
  deps: CreatorTipsDeps,
  env: Record<string, string | undefined>,
  cache: CreatorTipsCache,
  request: CreatorTipsRequest | undefined
): Promise<CreatorTipsResult> {
  const enabled = creatorTipsEnvSwitch(env) ?? request?.platformOn === true

  if (!enabled) {
    return { enabled: false, ok: true, tips: [] }
  }

  const bearer = deps.accessToken()

  if (!bearer) {
    return { enabled, message: 'NOT_SIGNED_IN', ok: false, tips: cache.tips }
  }

  try {
    const parsed = parseCreatorTips(await deps.getJson(creatorTipsUrl(deps.apiBase(), cache.hash), { bearer }))

    if (!parsed) {
      deps.log('[creator-tips] malformed catalog reply; keeping the last one')

      return { enabled, message: 'INVALID', ok: false, tips: cache.tips }
    }

    if (!('unchanged' in parsed)) {
      cache.hash = parsed.hash
      cache.tips = parsed.tips
    }

    return { enabled, ok: true, tips: cache.tips }
  } catch (error) {
    deps.log(`[creator-tips] catalog read failed (${statusOf(error) ?? 'network'}); keeping the last one`)

    return { enabled, message: 'FETCH_FAILED', ok: false, tips: cache.tips }
  }
}
