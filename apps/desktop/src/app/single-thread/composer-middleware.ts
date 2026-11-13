/**
 * hc-1014 单线对话: what a send does in the one thread, as a composer
 * middleware (the chain every typed, queued and voice send passes through in
 * the ChatBar — app/chat/composer/contrib.ts). Registered only while single-
 * thread product mode is on, so the switch off leaves the chain exactly as it
 * was.
 *
 * - In the thread: a new local day, 6 idle hours or 「从头来」 first opens a new
 *   segment (session.compress: the runtime's own summary-and-rotate), then the
 *   message goes out. `/new` alone opens a segment and sends nothing — the
 *   thread never forks (the same guard Bot Mode puts on its canonical chat);
 *   the composer clears as for a sent message (hc-1226), and keeps `/new`
 *   only when no segment could open.
 * - On the empty thread (no thread yet): the message goes out and the session
 *   it creates is claimed as the thread (titled {@link MAIN_THREAD_TITLE}).
 * - Anywhere else (an earlier conversation; the thread still being looked up,
 *   or the lookup failed; hc-1077: another assistant asked for and not yet
 *   answering; hc-1146: its conversation still loading): nothing is sent and
 *   the text stays in the composer.
 *   Fail closed: a send that cannot be placed in the thread must not mint a
 *   second one.
 * - hc-1146: with several assistants on, a send made while the thread is only
 *   opening (the assistant's engine starting, its thread being looked up or
 *   its conversation loading) is held instead (held-sends.ts): it shows above
 *   the composer as waiting and goes out once the thread is on screen.
 *   Only a plain send is held; one bound to options (a queued entry, machine
 *   text, a voice-live turn) still stays where it came from.
 */

import { atom, computed } from 'nanostores'

import {
  COMPOSER_SEND_DONE,
  COMPOSER_SEND_TAKEN,
  type ComposerDraft,
  type ComposerMiddlewareResult
} from '@/app/chat/composer/contrib'
import { SESSION_COMPRESS_TIMEOUT_MS } from '@/app/session/hooks/use-prompt-actions/slash'
import { singleThreadChatCopyNow } from '@/i18n/single-thread-chat'
import { holdSend } from '@/store/held-sends'
import {
  $mainThread,
  isMainThreadStoredId,
  MAIN_THREAD_TITLE,
  noteMainThreadClaimed,
  recordSegmentStart,
  resolveMainThread
} from '@/store/main-thread'
import { dismissNotification, notify } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeSessionId, $busy, $gatewayState, $messages, $selectedStoredSessionId, $sessions } from '@/store/session'
import { isSingleThreadMode } from '@/store/single-thread'
import { $currentBotProfile, $multiBotMode, isMultiBotMode } from '@/store/single-thread-bots'

import {
  isRestartRequest,
  isSlashBranch,
  isSlashNew,
  lastActivitySeconds,
  segmentBoundary,
  type SegmentReason
} from './segments'

export type RequestGateway = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>

/**
 * hc-1218: every new segment's summary is asked for with a focus that starts with this marker. The
 * engine's segment-summary seam (apex_overlay/segment_summary.py `MARKER`, pinned by a test there)
 * reads it as "this compression is a segment boundary": the summary then records what was done and
 * what is still pending, not how, and opens with a line saying it is not this request's requirements.
 * A compression without it (the context window filling mid-task) stays the runtime's own.
 */
export const SEGMENT_SUMMARY_MARKER = '【新的一段】'

/** The focus each kind of new segment asks the summarizer for; the text after the marker is what an engine without the seam reads. */
export const SEGMENT_FOCUS: Readonly<Record<SegmentReason, string>> = {
  day: `${SEGMENT_SUMMARY_MARKER}只记以前做成了什么、还差什么，不记做法；用户自己说过的偏好照记。`,
  idle: `${SEGMENT_SUMMARY_MARKER}只记以前做成了什么、还差什么，不记做法；用户自己说过的偏好照记。`,
  restart: `${SEGMENT_SUMMARY_MARKER}用户要从头开始一个新话题：只留下关于用户的长期信息和还没做完的事，不记做法。`
}

/** How long a send waits for the rotation a new segment causes before it goes out anyway. */
const ROTATION_WAIT_MS = 3_000
/** A draft send claims the session it creates for this long. */
const CLAIM_WINDOW_MS = 60_000

/** A send from the empty thread is waiting for its session to exist (then it is titled). */
export const $pendingThreadClaim = atom<null | { at: number; profile: string }>(null)

interface CompressResult {
  removed?: number
  status?: string
  summary?: { aborted?: boolean; noop?: boolean }
}

function waitForRotation(fromStoredId: string, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(done, timeoutMs)
    const stop = $selectedStoredSessionId.listen(id => id !== fromStoredId && done())

    function done() {
      window.clearTimeout(timer)
      stop()
      resolve()
    }
  })
}

/**
 * Open a new segment of the thread on screen. Resolves to whether one opened (its line is drawn, whether or
 * not the runtime had anything to fold yet); false when none did: a turn running, the thread not bound, or
 * the summary failed.
 */
export async function startThreadSegment(request: RequestGateway, reason: SegmentReason): Promise<boolean> {
  const runtimeId = $activeSessionId.get()
  const storedId = $selectedStoredSessionId.get()
  const rootId = $mainThread.get().rootId

  if (!runtimeId || !storedId || !rootId || $busy.get()) {
    return false
  }

  const noticeId = notify({ durationMs: 0, kind: 'info', message: singleThreadChatCopyNow().segmentStarting })

  try {
    const result = await request<CompressResult>(
      'session.compress',
      { session_id: runtimeId, focus_topic: SEGMENT_FOCUS[reason] },
      SESSION_COMPRESS_TIMEOUT_MS
    )

    recordSegmentStart(rootId, Date.now() / 1000)

    const rotated = result?.status !== 'aborted' && !result?.summary?.noop && result?.removed !== 0

    if (rotated) {
      await waitForRotation(storedId, ROTATION_WAIT_MS)
    }

    return true
  } catch {
    // A failed summary must not cost the user their message: it goes out in the current segment.
    return false
  } finally {
    dismissNotification(noticeId)
  }
}

/**
 * hc-1146: with several assistants, a conversation is selected but not bound yet — its history
 * still loading (an assistant just switched to). The composer stays on screen meanwhile
 * (composer-while-loading.ts) and its sends wait; a Quick Entry capture waits for it too
 * (quick-entry.ts botSwitchSettled).
 */
export function conversationLoading(): boolean {
  return isMultiBotMode() && $selectedStoredSessionId.get() !== null && !$activeSessionId.get()
}

/**
 * Where a send made now would go, for the active profile `profileKey` — one
 * rule for this middleware and for releasing a held send (held-sends.ts):
 *
 * - `connecting` (hc-1146, several assistants only): the gateway is not open —
 *   the main engine still starting, or a reconnect; with one assistant the
 *   composer refuses sends itself then (composer-while-loading.ts);
 * - `switching` (hc-1077): another assistant was asked for and is not the one
 *   answering yet; the thread on hand is still the previous one's;
 * - `looking-up`: the thread is not known yet (or the lookup is running);
 * - `unavailable`: the lookup failed;
 * - `elsewhere`: an earlier conversation is on screen, read-only;
 * - `new`: there is no thread yet and nothing else is on screen: the send starts it;
 * - `selecting`: the thread exists and the shell is on its way there;
 * - `loading` (hc-1146): it is selected but its conversation is still loading;
 * - `thread`: it is on screen and bound.
 */
export type SendPlace =
  'connecting' | 'elsewhere' | 'loading' | 'looking-up' | 'new' | 'selecting' | 'switching' | 'thread' | 'unavailable'

export function sendPlace(profileKey: string): SendPlace {
  if (isMultiBotMode() && $gatewayState.get() !== 'open') {
    return 'connecting'
  }

  if (isMultiBotMode() && $currentBotProfile.get() !== profileKey) {
    return 'switching'
  }

  const thread = $mainThread.get()
  const storedId = $selectedStoredSessionId.get()

  if (thread.status === 'unknown' || thread.status === 'loading') {
    return 'looking-up'
  }

  if (thread.status === 'error') {
    return 'unavailable'
  }

  if (thread.status === 'absent') {
    return storedId ? 'elsewhere' : 'new'
  }

  if (!storedId) {
    return 'selecting'
  }

  if (conversationLoading()) {
    return 'loading'
  }

  return isMainThreadStoredId(storedId, thread, $sessions.get()) ? 'thread' : 'elsewhere'
}

/** The thread is on its way: a send now can neither go in nor be told it is in the wrong place. */
export function threadOpening(place: SendPlace): boolean {
  return (
    place === 'connecting' ||
    place === 'switching' ||
    place === 'looking-up' ||
    place === 'selecting' ||
    place === 'loading'
  )
}

/** {@link sendPlace} for the active profile, for what renders it (subscribe; never `.get()` it unwatched). */
export const $sendPlace = computed(
  [
    $multiBotMode,
    $gatewayState,
    $currentBotProfile,
    $activeGatewayProfile,
    $mainThread,
    $selectedStoredSessionId,
    $activeSessionId,
    $sessions
  ],
  (_multiBot, _gateway, _current, active) => sendPlace(normalizeProfileKey(active))
)

function refuse(message: string): null {
  notify({ kind: 'info', message })

  return null
}

/**
 * The thread is opening. hc-1146: with several assistants on, a plain send waits
 * for it, held for the assistant on screen; otherwise it stays in the composer.
 */
function waitForThread(draft: ComposerDraft, message: string): ComposerMiddlewareResult {
  if (!isMultiBotMode() || draft.bound) {
    return refuse(message)
  }

  holdSend($currentBotProfile.get(), draft)

  return COMPOSER_SEND_TAKEN
}

/** The middleware itself. `request` is read at call time so it always reaches the live socket. */
export async function singleThreadSend(
  draft: ComposerDraft,
  request: () => null | RequestGateway,
  profile: () => string
): Promise<ComposerMiddlewareResult> {
  if (!isSingleThreadMode()) {
    return draft
  }

  const copy = singleThreadChatCopyNow()
  const place = sendPlace(normalizeProfileKey(profile()))
  const gateway = request()

  if (place === 'connecting' || place === 'switching') {
    return waitForThread(draft, copy.threadOpening)
  }

  if (place === 'looking-up' || place === 'unavailable') {
    if (gateway && $mainThread.get().status !== 'loading') {
      void resolveMainThread(gateway, profile())
    }

    return place === 'unavailable' ? refuse(copy.threadUnavailable) : waitForThread(draft, copy.threadOpening)
  }

  if (place === 'elsewhere') {
    return refuse(copy.readOnlyLine)
  }

  if (place === 'new') {
    $pendingThreadClaim.set({ at: Date.now(), profile: profile() })

    return draft
  }

  if (place === 'selecting' || place === 'loading') {
    // The thread exists and the shell is on its way there: wait for it rather than start another.
    return waitForThread(draft, copy.threadOpening)
  }

  if (!gateway) {
    return draft
  }

  if (isSlashBranch(draft.text)) {
    return refuse(copy.noBranch)
  }

  if (isSlashNew(draft.text)) {
    // hc-1226: carried out, `/new` must not come back into the composer (sent again, it would fold the
    // thread a second time); not carried out, it stays there to send again.
    if (!(await startThreadSegment(gateway, 'restart'))) {
      return refuse(copy.restartNotNow)
    }

    notify({ kind: 'info', message: copy.restarted })

    return COMPOSER_SEND_DONE
  }

  const reason: null | SegmentReason = isRestartRequest(draft.text)
    ? 'restart'
    : segmentBoundary(lastActivitySeconds($messages.get()), Date.now() / 1000)

  if (reason) {
    await startThreadSegment(gateway, reason)
  }

  return draft
}

/**
 * Title the session a draft send just created, so it IS the thread. A title
 * already in use means another window made the thread first: look it up again
 * and let the shell move there.
 */
export async function claimCreatedThread(request: RequestGateway, storedId: string): Promise<void> {
  const pending = $pendingThreadClaim.get()
  const runtimeId = $activeSessionId.get()

  if (!pending || Date.now() - pending.at > CLAIM_WINDOW_MS || !runtimeId) {
    $pendingThreadClaim.set(null)

    return
  }

  try {
    await request('session.title', { session_id: runtimeId, title: MAIN_THREAD_TITLE })
    noteMainThreadClaimed(pending.profile, storedId)
  } catch {
    await resolveMainThread(request, pending.profile)
  } finally {
    $pendingThreadClaim.set(null)
  }
}
