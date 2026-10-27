/**
 * hc-1061 G3: what the single-thread sidebar's assistant row says under 「APEX」,
 * and whether it carries the unread dot (prototype v2: 「最新一句 / 在做什么 /
 * 等你决定 / 通话中」).
 *
 * The thread's own session state is global ($sessionStates), so the row reads
 * busy, a waiting question and the latest reply from it wherever the user is.
 * Two things only the conversation surfaces know arrive through
 * thread-signals.ts: the activity line names the step in progress (it is
 * mounted only while the conversation is on screen and the turn runs), and the
 * voice panel says a call is open. Without them the row still says 在做事… or
 * 等你决定.
 *
 * hc-1077 (several assistants): every assistant's row reads the same way from
 * its own profile's thread (`$mainThreadsByProfile`), and remembers its own
 * last seen reply ({@link markBotReplySeen}); the two signals above belong to
 * the conversation on screen, so only the assistant on screen reads them.
 */

import { atom, computed } from 'nanostores'

import type { ClientSessionState } from '@/app/types'
import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'

import { $mainThread, $mainThreadsByProfile, type MainThreadState } from './main-thread'
import { $sessionStates } from './session-states'
import { $threadActivity, $threadInCall, type ThreadActivity } from './thread-signals'

export type ThreadPresence =
  | { kind: 'call' }
  | { kind: 'idle'; text: null | string }
  | { kind: 'waiting' }
  | { kind: 'working'; text: null | string }

export interface ThreadReply {
  id: string
  /** Its first line of plain text, for a one-line preview. */
  line: string
}

/** The newest APEX reply the user has had the conversation open for; null until they first open it. */
export const $threadSeenReplyId = atom<null | string>(null)

/** The thread's session state, or null while the thread is not found or not loaded. */
export function mainThreadState(
  states: Record<string, ClientSessionState>,
  thread: MainThreadState
): ClientSessionState | null {
  if (thread.status !== 'found') {
    return null
  }

  const candidates = Object.values(states).filter(
    state => state.storedSessionId !== null && thread.ids.includes(state.storedSessionId)
  )

  return candidates.find(state => state.storedSessionId === thread.tipId) ?? candidates[0] ?? null
}

/** Markdown block markers that would read as noise in a one-line preview (a heading, a quote, a list item). */
const LEADING_MARKS = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/
const INLINE_MARKS = /[*_`~]+/g

/** The newest APEX reply with words in it, as a one-line preview. */
export function latestReply(messages: readonly ChatMessage[]): null | ThreadReply {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!

    if (message.role !== 'assistant' || message.hidden) {
      continue
    }

    const line = chatMessageText(message)
      .split('\n')
      .map(text => text.trim().replace(LEADING_MARKS, '').replace(INLINE_MARKS, '').trim())
      .find(Boolean)

    if (line) {
      return { id: message.id, line }
    }
  }

  return null
}

export function presenceOf(
  state: ClientSessionState | null,
  activity: null | ThreadActivity,
  inCall: boolean,
  reply: null | ThreadReply
): ThreadPresence {
  if (inCall) {
    return { kind: 'call' }
  }

  if (activity?.waiting || state?.needsInput) {
    return { kind: 'waiting' }
  }

  if (activity || state?.busy) {
    return { kind: 'working', text: activity?.text || null }
  }

  return { kind: 'idle', text: reply?.line ?? null }
}

export const $mainThreadState = computed([$sessionStates, $mainThread], mainThreadState)

export const $threadLatestReply = computed($mainThreadState, state => latestReply(state?.messages ?? []))

export const $threadPresence = computed(
  [$mainThreadState, $threadActivity, $threadInCall, $threadLatestReply],
  presenceOf
)

/** A reply came in since the user last had the conversation open. */
export const $threadUnread = computed(
  [$threadLatestReply, $threadSeenReplyId],
  (reply, seen) => reply !== null && seen !== null && reply.id !== seen
)

/** hc-1077: per profile, the newest reply the user has had that assistant's conversation open for. */
export const $botSeenReplyIds = atom<Readonly<Record<string, string>>>({})

export function markBotReplySeen(profile: string, id: null | string): void {
  if (id !== null && $botSeenReplyIds.get()[profile] !== id) {
    $botSeenReplyIds.set({ ...$botSeenReplyIds.get(), [profile]: id })
  }
}

/** A reply came in since the user last had this assistant's conversation open (never before they first did). */
export function botUnread(reply: null | ThreadReply, seen: string | undefined): boolean {
  return reply !== null && seen !== undefined && reply.id !== seen
}

/** `profile`'s thread: the active one's as the shell holds it, else as last looked up. */
export function profileThread(
  profile: string,
  active: MainThreadState,
  byProfile: Readonly<Record<string, MainThreadState>>
): MainThreadState | undefined {
  return active.profile === profile ? active : byProfile[profile]
}

/** Which profile's thread `storedId` is on, among the threads this window holds; null when none. */
export function profileOfThreadStoredId(storedId: null | string | undefined): null | string {
  if (!storedId) {
    return null
  }

  const held = Object.values($mainThreadsByProfile.get()).find(
    thread => thread.status === 'found' && thread.ids.includes(storedId)
  )

  return held?.profile ?? null
}

export function markThreadReplySeen(id: null | string): void {
  if (id !== null && $threadSeenReplyId.get() !== id) {
    $threadSeenReplyId.set(id)
  }
}

export function resetThreadPresenceForTest(): void {
  $threadActivity.set(null)
  $threadInCall.set(false)
  $threadSeenReplyId.set(null)
  $botSeenReplyIds.set({})
}
