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
 *   thread never forks (the same guard Bot Mode puts on its canonical chat).
 * - On the empty thread (no thread yet): the message goes out and the session
 *   it creates is claimed as the thread (titled {@link MAIN_THREAD_TITLE}).
 * - Anywhere else (an earlier conversation; the thread still being looked up,
 *   or the lookup failed; hc-1077: another assistant asked for and not yet
 *   answering): nothing is sent and the text stays in the composer.
 *   Fail closed: a send that cannot be placed in the thread must not mint a
 *   second one.
 */

import { atom } from 'nanostores'

import type { ComposerDraft } from '@/app/chat/composer/contrib'
import { SESSION_COMPRESS_TIMEOUT_MS } from '@/app/session/hooks/use-prompt-actions/slash'
import { singleThreadChatCopyNow } from '@/i18n/single-thread-chat'
import {
  $mainThread,
  isMainThreadStoredId,
  MAIN_THREAD_TITLE,
  noteMainThreadClaimed,
  recordSegmentStart,
  resolveMainThread
} from '@/store/main-thread'
import { dismissNotification, notify } from '@/store/notifications'
import { normalizeProfileKey } from '@/store/profile'
import { $activeSessionId, $busy, $messages, $selectedStoredSessionId, $sessions } from '@/store/session'
import { isSingleThreadMode } from '@/store/single-thread'
import { $currentBotProfile, isMultiBotMode } from '@/store/single-thread-bots'

import {
  isRestartRequest,
  isSlashBranch,
  isSlashNew,
  lastActivitySeconds,
  segmentBoundary,
  type SegmentReason
} from './segments'

export type RequestGateway = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>

/** Asked the summarizer when the user starts over: keep who they are and what is unfinished. */
const RESTART_FOCUS = '用户要从头开始一个新话题：只留下关于用户的长期信息和还没做完的事，不必复述刚才的细节。'

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

/** Open a new segment of the thread on screen. Resolves to whether the runtime compressed it. */
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
      { session_id: runtimeId, ...(reason === 'restart' ? { focus_topic: RESTART_FOCUS } : {}) },
      SESSION_COMPRESS_TIMEOUT_MS
    )

    recordSegmentStart(rootId, Date.now() / 1000)

    const rotated = result?.status !== 'aborted' && !result?.summary?.noop && result?.removed !== 0

    if (rotated) {
      await waitForRotation(storedId, ROTATION_WAIT_MS)
    }

    return rotated
  } catch {
    // A failed summary must not cost the user their message: it goes out in the current segment.
    return false
  } finally {
    dismissNotification(noticeId)
  }
}

function refuse(message: string): null {
  notify({ kind: 'info', message })

  return null
}

/** The middleware itself. `request` is read at call time so it always reaches the live socket. */
export async function singleThreadSend(
  draft: ComposerDraft,
  request: () => null | RequestGateway,
  profile: () => string
): Promise<ComposerDraft | null> {
  if (!isSingleThreadMode()) {
    return draft
  }

  const copy = singleThreadChatCopyNow()

  // hc-1077: the thread on hand is the previous assistant's until the switch lands.
  if (isMultiBotMode() && $currentBotProfile.get() !== normalizeProfileKey(profile())) {
    return refuse(copy.threadOpening)
  }

  const thread = $mainThread.get()
  const storedId = $selectedStoredSessionId.get()
  const gateway = request()

  if (thread.status === 'unknown' || thread.status === 'loading' || thread.status === 'error') {
    if (gateway && thread.status !== 'loading') {
      void resolveMainThread(gateway, profile())
    }

    return refuse(thread.status === 'error' ? copy.threadUnavailable : copy.threadOpening)
  }

  if (thread.status === 'absent') {
    if (storedId) {
      return refuse(copy.readOnlyLine)
    }

    $pendingThreadClaim.set({ at: Date.now(), profile: profile() })

    return draft
  }

  if (!storedId) {
    // The thread exists and the shell is on its way there: wait for it rather than start another.
    return refuse(copy.threadOpening)
  }

  if (!isMainThreadStoredId(storedId, thread, $sessions.get())) {
    return refuse(copy.readOnlyLine)
  }

  if (!gateway) {
    return draft
  }

  if (isSlashBranch(draft.text)) {
    return refuse(copy.noBranch)
  }

  if (isSlashNew(draft.text)) {
    await startThreadSegment(gateway, 'restart')
    notify({ kind: 'info', message: copy.restarted })

    return null
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
