/**
 * hc-1014 单线对话: which stored session is the assistant's one thread.
 *
 * The thread is identified by NAME, never by a stored-id pointer — the same
 * contract Bot Mode's canonical "Bot Chat" settled on (src/AGENTS.md): the
 * profile's session titled exactly {@link MAIN_THREAD_TITLE}. `session.list`
 * with `title` is an indexed, window-free lookup that resolves a compression
 * lineage to its live tip (`resolved_id`), so every segment the runtime rotates
 * into stays the same thread. The lookup FAILS CLOSED: a failed or unconfirmed
 * read is `error`, never `absent`, because `absent` is what lets the first
 * message mint a new thread.
 *
 * The title is an identity key, not copy: it never changes with the locale or
 * with the name the user gives the assistant.
 *
 * hc-1077 (several assistants): each assistant is a profile with its own
 * thread under the same title. `$mainThread` stays the active profile's;
 * `$mainThreadsByProfile` keeps every profile's last settled thread, so the
 * sidebar can follow an assistant working in the background.
 */

import { atom, computed } from 'nanostores'

import { readJson, writeJson } from '@/lib/storage'
import type { SessionInfo } from '@/types/hermes'

import { $activeSessionStoredIdRotation, resolveComposerSessionKey } from './session'

export const MAIN_THREAD_TITLE = 'APEX 主线'

export type MainThreadStatus = 'absent' | 'error' | 'found' | 'loading' | 'unknown'

export interface MainThreadState {
  /** Every stored id seen on the thread's lineage: the registry root, the tip, each rotation. */
  ids: readonly string[]
  /** The profile the lookup ran for; a profile switch makes the state stale. */
  profile: null | string
  /** The registry row (lineage root) — the thread's identity. */
  rootId: null | string
  status: MainThreadStatus
  /** The live tip to open. */
  tipId: null | string
}

const EMPTY: MainThreadState = { ids: [], profile: null, rootId: null, status: 'unknown', tipId: null }

export const $mainThread = atom<MainThreadState>(EMPTY)

/** Every profile's thread as last settled in this window (the active one included). */
export const $mainThreadsByProfile = atom<Readonly<Record<string, MainThreadState>>>({})

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

interface TitleLookupRow {
  id?: null | string
  resolved_id?: null | string
  root_title?: null | string
  title?: null | string
}

/** Upper bound for the title lookup (the gateway answers one row; the limit only bounds older gateways). */
const LOOKUP_LIMIT = 200

let lookupSerial = 0

function isMainThreadRow(row: TitleLookupRow): boolean {
  const rootTitle = String(row?.root_title || '').trim()
  const title = String(row?.title || '').trim()

  return rootTitle === MAIN_THREAD_TITLE || (!rootTitle && title === MAIN_THREAD_TITLE)
}

function found(profile: string, rootId: string, tipId: string): MainThreadState {
  return { ids: [...new Set([rootId, tipId])], profile, rootId, status: 'found', tipId }
}

/** One title lookup for `profile`, through whichever gateway `request` reaches (it names the profile). */
async function lookupMainThread(request: RequestGateway, profile: string): Promise<MainThreadState> {
  try {
    const result = await request<{ sessions?: TitleLookupRow[] }>('session.list', {
      include_hidden: true,
      limit: LOOKUP_LIMIT,
      profile,
      title: MAIN_THREAD_TITLE
    })

    const row = (result?.sessions ?? []).find(isMainThreadRow)
    const rootId = String(row?.id || '')

    return rootId ? found(profile, rootId, String(row?.resolved_id || rootId)) : { ...EMPTY, profile, status: 'absent' }
  } catch {
    return { ...EMPTY, profile, status: 'error' }
  }
}

/**
 * Look the thread up for `profile`. Resolves to the settled state; only the
 * newest lookup lands, so a profile switch mid-read cannot publish the old
 * profile's thread.
 */
export async function resolveMainThread(request: RequestGateway, profile: string): Promise<MainThreadState> {
  const serial = ++lookupSerial

  if ($mainThread.get().profile !== profile) {
    $mainThread.set({ ...EMPTY, profile, status: 'loading' })
  } else if ($mainThread.get().status !== 'found') {
    $mainThread.set({ ...$mainThread.get(), status: 'loading' })
  }

  const next = await lookupMainThread(request, profile)

  if (serial !== lookupSerial) {
    return $mainThread.get()
  }

  // A thread this window already holds is never downgraded by one unconfirmed read.
  const held = $mainThread.get()

  if (next.status !== 'found' && held.status === 'found' && held.profile === profile) {
    return held
  }

  $mainThread.set(next.status === 'found' && held.profile === profile ? mergeIds(next, held.ids) : next)

  return $mainThread.get()
}

function mergeIds(state: MainThreadState, extra: readonly string[]): MainThreadState {
  return { ...state, ids: [...new Set([...state.ids, ...extra])] }
}

/**
 * hc-1077: look up the thread of an assistant that is not the active one, for
 * its sidebar row. Lands only in `$mainThreadsByProfile`, and like the active
 * lookup never downgrades a thread this window already holds.
 */
export async function resolveProfileThread(request: RequestGateway, profile: string): Promise<MainThreadState> {
  const next = await lookupMainThread(request, profile)

  recordProfileThread(next)

  return $mainThreadsByProfile.get()[profile] ?? next
}

function recordProfileThread(state: MainThreadState): void {
  const profile = state.profile

  if (!profile || state.status === 'loading' || state.status === 'unknown') {
    return
  }

  const held = $mainThreadsByProfile.get()[profile]

  if (held?.status === 'found' && state.status !== 'found') {
    return
  }

  const next = state.status === 'found' && held?.rootId === state.rootId ? mergeIds(state, held.ids) : state

  $mainThreadsByProfile.set({ ...$mainThreadsByProfile.get(), [profile]: next })
}

// The active profile's thread is every profile's too.
$mainThread.listen(recordProfileThread)

/** The first message of a brand-new thread created this stored session and titled it. */
export function noteMainThreadClaimed(profile: string, storedId: string): void {
  lookupSerial += 1
  $mainThread.set(found(profile, storedId, storedId))
}

/**
 * Is `storedId` on the thread's lineage? Matches the ids this window has seen
 * (root, tip, every rotation it followed) and, through the session list, any
 * other segment of the same compression chain.
 */
export function isMainThreadStoredId(
  storedId: null | string | undefined,
  state: MainThreadState,
  sessions: readonly Pick<SessionInfo, '_lineage_ids' | '_lineage_root_id' | 'id'>[]
): boolean {
  if (!storedId || state.status !== 'found' || !state.rootId) {
    return false
  }

  if (state.ids.includes(storedId)) {
    return true
  }

  const key = resolveComposerSessionKey(storedId, sessions)

  return Boolean(key && (key === state.rootId || state.ids.includes(key)))
}

// A rotation (compression, or a new segment) moves the thread onto a new tip
// before the session list knows it. Follow it here so the tip never reads as
// "some other conversation" in the gap.
$activeSessionStoredIdRotation.listen(rotation => {
  const state = $mainThread.get()

  if (rotation && state.status === 'found' && state.ids.includes(rotation.previousStoredSessionId)) {
    $mainThread.set({ ...mergeIds(state, [rotation.nextStoredSessionId]), tipId: rotation.nextStoredSessionId })
  }

  // hc-1077: a background assistant's thread rotates too.
  for (const held of Object.values($mainThreadsByProfile.get())) {
    if (rotation && held.status === 'found' && held.ids.includes(rotation.previousStoredSessionId)) {
      recordProfileThread({ ...mergeIds(held, [rotation.nextStoredSessionId]), tipId: rotation.nextStoredSessionId })
    }
  }
})

// ── Segment starts ───────────────────────────────────────────────────────────
// When this window opened a new segment (a new day, 6 idle hours, 「从头来」),
// keyed by the thread's root. The transcript draws its 「新的一段」 line from
// these; a day change is drawn from the timestamps alone. Global per install:
// the local engine's thread belongs to this machine.

const SEGMENT_STARTS_KEY = 'apex.single-thread.segment-starts.v1'
const SEGMENT_STARTS_LIMIT = 200

type SegmentStarts = Readonly<Record<string, readonly number[]>>

function loadSegmentStarts(): SegmentStarts {
  const raw = readJson<unknown>(SEGMENT_STARTS_KEY)

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const out: Record<string, number[]> = {}

  for (const [root, values] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(values)) {
      out[root] = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    }
  }

  return out
}

/** Segment start times (epoch seconds) per thread root. */
export const $segmentStarts = atom<SegmentStarts>(loadSegmentStarts())

const NO_SEGMENT_STARTS: readonly number[] = []

/** The segment starts of the thread this window holds. */
export const $threadSegmentStarts = computed([$segmentStarts, $mainThread], (starts, thread) =>
  thread.rootId ? (starts[thread.rootId] ?? NO_SEGMENT_STARTS) : NO_SEGMENT_STARTS
)

export function recordSegmentStart(rootId: string, atSeconds: number): void {
  const current = $segmentStarts.get()
  const next = [...(current[rootId] ?? []), atSeconds].slice(-SEGMENT_STARTS_LIMIT)

  $segmentStarts.set({ ...current, [rootId]: next })
  writeJson(SEGMENT_STARTS_KEY, $segmentStarts.get())
}

/** Tests only. */
export function resetMainThreadForTest(): void {
  lookupSerial += 1
  $mainThread.set(EMPTY)
  $mainThreadsByProfile.set({})
  $segmentStarts.set({})
  writeJson(SEGMENT_STARTS_KEY, null)
}
