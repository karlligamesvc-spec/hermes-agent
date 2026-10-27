/**
 * hc-1077: what one assistant's sidebar row says under its name, in one place
 * — the status line, whether it reads as busy, and the unread dot. Everything
 * a row shows about its assistant's state is decided here, so later states
 * (hc-1079's first-open questions, read from the row's `bot.uiMeta`) slot in
 * beside the others.
 *
 * - The assistant on screen reads the activity line and the voice panel
 *   (store/thread-signals.ts), as APEX's single row always has.
 * - One in the background folds its own session state (bot-activity.ts).
 * - One never opened in this window shows its thread's last line from
 *   `profiles.list`, or just its name.
 * - The dot: a reply after the last one the user had that conversation open
 *   for. Being on screen marks the newest one seen.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { useI18n } from '@/i18n'
import { $mainThread, $mainThreadsByProfile, type MainThreadState } from '@/store/main-thread'
import { $sessionStates } from '@/store/session-states'
import { $botLastSessions, type ApexBot } from '@/store/single-thread-bots'
import {
  $botSeenReplyIds,
  botUnread,
  latestReply,
  mainThreadState,
  markBotReplySeen,
  presenceOf,
  profileThread,
  type ThreadPresence,
  type ThreadReply
} from '@/store/single-thread-presence'
import { $threadActivity, $threadInCall } from '@/store/thread-signals'

import { backgroundActivity } from './bot-activity'
import { useStatusLine } from './sidebar-status'

export interface BotRowStatus {
  /** idle / working / waiting / call: the face looks down while working, the line reads busy unless idle. */
  kind: ThreadPresence['kind']
  /** Under the name; null shows the name alone. */
  line: null | string
  unread: boolean
}

/**
 * A row never opened in this window has no session state: its last line comes
 * from `profiles.list` — only when that newest conversation is its thread.
 */
function previewReply(
  thread: MainThreadState | undefined,
  last: undefined | { id: string; preview: string }
): null | ThreadReply {
  if (!last?.preview || thread?.status !== 'found' || !thread.ids.includes(last.id)) {
    return null
  }

  // The same one-line reading the latest reply gets.
  return latestReply([{ id: `preview:${last.id}`, parts: [{ text: last.preview, type: 'text' }], role: 'assistant' }])
}

/**
 * `current`: this assistant is the one on screen (asked for or active).
 * `onScreen`: and its conversation is the page showing.
 */
export function useBotRowStatus(
  bot: ApexBot,
  { current, onScreen }: { current: boolean; onScreen: boolean }
): BotRowStatus {
  const { t } = useI18n()
  const states = useStore($sessionStates)
  const activeThread = useStore($mainThread)
  const threads = useStore($mainThreadsByProfile)
  const lastSessions = useStore($botLastSessions)
  const thread = profileThread(bot.profile, activeThread, threads)
  const state = thread ? mainThreadState(states, thread) : null
  const reply = latestReply(state?.messages ?? [])
  // The activity line and the voice panel speak for the conversation on screen only.
  const signal = useStore($threadActivity)
  const inCall = useStore($threadInCall)
  const activity = current ? signal : backgroundActivity(state, t.assistant.tool.process)

  const presence = presenceOf(
    state,
    activity,
    current && inCall,
    reply ?? previewReply(thread, lastSessions[bot.profile])
  )

  const line = useStatusLine(presence)
  const seen = useStore($botSeenReplyIds)[bot.profile]

  useEffect(() => {
    if (onScreen) {
      markBotReplySeen(bot.profile, reply?.id ?? null)
    }
  }, [bot.profile, onScreen, reply?.id])

  return { kind: presence.kind, line, unread: botUnread(reply, seen) && !onScreen }
}
