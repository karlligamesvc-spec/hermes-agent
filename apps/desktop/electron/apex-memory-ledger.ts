/**
 * apex-memory-ledger.ts — hc-1016 记得你 v1: the account's memory ledger
 *
 * The cloud keeps one ledger per person (关于你 / 最近发生的), shared by APEX
 * Desktop and, later, the account's IM assistants. This module is the
 * main-process leg: it reads and edits the ledger with the stored login JWT
 * (which never reaches the renderer) for the 「它记得什么」 page and the 撤销 on a
 * 记下了 line, and keeps the local agent's copy of the cloud's rendered segment
 * in step. Electron-free so it runs under `vitest --project electron`.
 *
 * The renderer calls it only while `desktop_features.single_thread` is on; with
 * the switch off it sends `{ action: 'off' }`, which removes the local copy and
 * touches no network. The local engine writes the ledger itself through the
 * agent-key route (apex_overlay/memory_ledger.py, the apex_memory tool).
 *
 * Backend contract (apex-nodes `app/routers/memory_ledger.py`):
 *   GET    {API_BASE}/api/v1/account/memory-ledger
 *   POST   {API_BASE}/api/v1/account/memory-ledger/entries        body { kind, content }
 *   PATCH  {API_BASE}/api/v1/account/memory-ledger/entries/{id}   body { content }
 *   DELETE {API_BASE}/api/v1/account/memory-ledger/entries/{id}
 *   Authorization: Bearer <login JWT>
 *   200/201 → { entries: { about_you: Entry[], recent: Entry[] }, limits, prompt_segment,
 *               entry?, created?, deleted? }
 *   401 → session expired · 403 → installer-only account · 404 → an entry that is
 *   gone, or a cloud from before this API · 409 / 422 → { detail: { code } }
 *
 * Local copy: <HERMES_HOME>/apex/memory-ledger-prompt.md holds prompt_segment
 * verbatim, or is absent. The apex-overlay `apex.memory-ledger` section reads it
 * when each new session starts, and its presence is what offers the apex_memory
 * tool. It is removed with the switch off, on sign-out or a change of account
 * (clearAccountPromptMirrors), and a reply for an account that is no longer
 * signed in never writes it. Entry text is never logged.
 */

import fs from 'node:fs'
import path from 'node:path'

import { managedAccountId } from './apex-account-boundary'
import { clearUserProfilePrompt, type CreatorProfileDeps } from './apex-creator-profile'

export const MEMORY_KINDS = ['about_you', 'recent'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface MemoryLedgerEntry {
  content: string
  createdAt: string
  id: string
  kind: MemoryKind
  /** desktop: the local engine · app: the user on the page · im: a cloud assistant. */
  source: string
}

export interface MemoryLedgerState {
  aboutYou: MemoryLedgerEntry[]
  limits: { aboutYouMax: number; contentMaxChars: number; recentKeepDays: number; recentMax: number }
  recent: MemoryLedgerEntry[]
}

export type MemoryLedgerRequest =
  | { action: 'add'; content: string; kind: MemoryKind }
  | { action: 'edit'; content: string; id: string }
  | { action: 'get' }
  | { action: 'off' }
  | { action: 'remove'; id: string }

export interface MemoryLedgerResult {
  /** The cloud's reason when it refused a write (content_too_long, sensitive_content, ledger_full…). */
  code?: string
  created?: boolean
  entry?: MemoryLedgerEntry
  /** null: switched off, or this account has no ledger (installer-only, or an older cloud). */
  ledger: MemoryLedgerState | null
  message?: 'FETCH_FAILED' | 'INVALID' | 'NOT_FOUND' | 'NOT_SIGNED_IN' | 'SESSION_EXPIRED'
  needsSignIn?: boolean
  ok: boolean
}

export type MemoryLedgerDeps = CreatorProfileDeps

const LEDGER_PATH = '/api/v1/account/memory-ledger'
const PROMPT_DIR = 'apex'
const PROMPT_FILE = 'memory-ledger-prompt.md'
// The runtime's plugin prompt sections cap each section at 4,000 characters.
const PROMPT_MAX_CHARS = 4_000
// Full ids or the 8-character refs the prompt shows: nothing else reaches the URL path.
const ENTRY_ID = /^[0-9a-f-]{8,36}$/i

export function memoryLedgerUrl(apiBase: string, id?: string): string {
  const base = `${String(apiBase || '').replace(/\/+$/, '')}${LEDGER_PATH}`

  return id === undefined ? base : `${base}/entries/${encodeURIComponent(id)}`
}

export function memoryLedgerPromptPath(hermesHome: string): string {
  return path.join(hermesHome, PROMPT_DIR, PROMPT_FILE)
}

function parseEntry(raw: unknown): MemoryLedgerEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const item = raw as Record<string, unknown>
  const kind = MEMORY_KINDS.find(value => value === item.kind)
  const content = typeof item.content === 'string' ? item.content.trim() : ''
  const id = typeof item.id === 'string' ? item.id : ''

  if (!kind || !content || !ENTRY_ID.test(id)) {
    return null
  }

  return {
    content,
    createdAt: typeof item.created_at === 'string' ? item.created_at : '',
    id,
    kind,
    source: typeof item.source === 'string' ? item.source : ''
  }
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** The cloud's reply as renderer state plus the segment, or null when it is malformed. */
export function parseMemoryLedger(
  body: unknown
): {
  entry: MemoryLedgerEntry | null
  promptSegment: string | null
  state: MemoryLedgerState
  created?: boolean
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const { created, entries, entry, limits, prompt_segment: segment } = body as Record<string, unknown>

  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return null
  }

  const lists = entries as Record<string, unknown>
  const list = (raw: unknown) => (Array.isArray(raw) ? raw.map(parseEntry).filter(item => item !== null) : [])
  const l = limits && typeof limits === 'object' ? (limits as Record<string, unknown>) : {}

  return {
    ...(typeof created === 'boolean' ? { created } : {}),
    entry: parseEntry(entry),
    promptSegment: typeof segment === 'string' && segment.trim() ? segment.trim() : null,
    state: {
      aboutYou: list(lists.about_you),
      limits: {
        aboutYouMax: count(l.about_you_max, 30),
        contentMaxChars: count(l.content_max_chars, 100),
        recentKeepDays: count(l.recent_keep_days, 30),
        recentMax: count(l.recent_max, 50)
      },
      recent: list(lists.recent)
    }
  }
}

/** Write the segment for the local agent, or remove the file when there is none. Never throws. */
export function syncMemoryLedgerPrompt(hermesHome: string, segment: string | null, log: (line: string) => void): void {
  const target = memoryLedgerPromptPath(hermesHome)

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
    log(`[memory-ledger] local prompt write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function clearMemoryLedgerPrompt(hermesHome: string): void {
  try {
    fs.rmSync(memoryLedgerPromptPath(hermesHome), { force: true })
  } catch {
    // Best-effort: the next account's first read or the next 'off' replaces it.
  }
}

/** The account changed or signed out: every account-level prompt copy leaves the local agent. */
export function clearAccountPromptMirrors(hermesHome: string): void {
  clearUserProfilePrompt(hermesHome)
  clearMemoryLedgerPrompt(hermesHome)
}

function statusCodeOf(error: unknown): number | undefined {
  const code = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined

  return typeof code === 'number' ? code : undefined
}

/** detail.code from the `"<status>: <body>"` message the authed JSON calls reject with. */
function refusalCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : ''
  const body = message.slice(message.indexOf(':') + 1).trim()

  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail
    const code = detail && typeof detail === 'object' ? (detail as { code?: unknown }).code : undefined

    return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function send(deps: MemoryLedgerDeps, token: string, request: MemoryLedgerRequest): Promise<unknown> {
  const apiBase = deps.apiBase()

  switch (request.action) {
    case 'add':
      return deps.postJson(memoryLedgerUrl(apiBase) + '/entries', {
        bearer: token,
        body: { content: String(request.content ?? ''), kind: request.kind }
      })

    case 'edit':
      return deps.postJson(memoryLedgerUrl(apiBase, request.id), {
        bearer: token,
        body: { content: String(request.content ?? '') },
        method: 'PATCH'
      })

    case 'remove':
      return deps.postJson(memoryLedgerUrl(apiBase, request.id), { bearer: token, body: {}, method: 'DELETE' })

    default:
      return deps.getJson(memoryLedgerUrl(apiBase), { bearer: token })
  }
}

function validRequest(request: MemoryLedgerRequest | null | undefined): request is MemoryLedgerRequest {
  switch (request?.action) {
    case 'get':

    case 'off':
      return true

    case 'add':
      return MEMORY_KINDS.includes(request.kind) && typeof request.content === 'string'

    case 'edit':
      return ENTRY_ID.test(String(request.id)) && typeof request.content === 'string'

    case 'remove':
      return ENTRY_ID.test(String(request.id))

    default:
      return false
  }
}

/** One read or write for the signed-in account. Never throws. */
export async function memoryLedgerRequest(
  deps: MemoryLedgerDeps,
  hermesHome: string,
  request: MemoryLedgerRequest | null | undefined
): Promise<MemoryLedgerResult> {
  if (request?.action === 'off') {
    clearMemoryLedgerPrompt(hermesHome)

    return { ledger: null, ok: true }
  }

  if (!validRequest(request)) {
    return { ledger: null, message: 'INVALID', ok: false }
  }

  const token = String(deps.accessToken() || '').trim()

  if (!token) {
    return { ledger: null, message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false }
  }

  const owner = managedAccountId(token)
  const stillOwner = () => managedAccountId(String(deps.accessToken() || '').trim()) === owner

  try {
    // Every write answers with the ledger as it now stands, like a read.
    const parsed = parseMemoryLedger(await send(deps, token, request))

    if (!parsed) {
      deps.log('[memory-ledger] unreadable reply')

      return { ledger: null, message: 'FETCH_FAILED', ok: false }
    }

    // A reply for an account that is no longer signed in never reaches this one's agent.
    if (!stillOwner()) {
      return { ledger: null, message: 'FETCH_FAILED', ok: false }
    }

    syncMemoryLedgerPrompt(hermesHome, parsed.promptSegment, deps.log)

    return {
      ...(parsed.created === undefined ? {} : { created: parsed.created }),
      ...(parsed.entry ? { entry: parsed.entry } : {}),
      ledger: parsed.state,
      ok: true
    }
  } catch (error) {
    const code = statusCodeOf(error)

    if (code === 401) {
      return { ledger: null, message: 'SESSION_EXPIRED', needsSignIn: true, ok: false }
    }

    if (request.action === 'get' && (code === 403 || code === 404)) {
      if (stillOwner()) {
        clearMemoryLedgerPrompt(hermesHome)
      }

      return { ledger: null, ok: true }
    }

    if (code === 404) {
      // The entry is already gone (deleted on another device, or by the assistant).
      const fresh = await memoryLedgerRequest(deps, hermesHome, { action: 'get' })

      return { ...fresh, message: 'NOT_FOUND', ok: false }
    }

    if (code === 409 || code === 422) {
      const reason = refusalCode(error)

      return { ...(reason ? { code: reason } : {}), ledger: null, message: 'INVALID', ok: false }
    }

    deps.log(`[memory-ledger] ${request.action} failed${code ? ` (${code})` : ''}`)

    return { ledger: null, message: 'FETCH_FAILED', ok: false }
  }
}
