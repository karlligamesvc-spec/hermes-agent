/**
 * hc-1077 多助手第一期 M1 (prototype v2 ⑥ Bots, ⑨ BotSwitch): the single-thread
 * sidebar's rows while several assistants are on (`desktop_features.multi_bot`).
 *
 * APEX first, always the purple circle; then each assistant the user made, in
 * the order they were made. A row is the assistant's face (its shape and
 * colour), its name, the same status line APEX's row has always had (the
 * latest reply, what it is doing, 等你决定, 通话中) and a dot for a reply not
 * yet seen. An assistant the user switched away from keeps working in its own
 * engine; its row follows it (bot-activity.ts).
 *
 * A click on another assistant switches to it (store/single-thread-bots.ts
 * `openBot`) and the shell opens its 「APEX 主线」; a click on the one on
 * screen goes back to its conversation, as APEX's row did. Renaming, a new
 * look and deleting are hc-1078's (the 「+」 asks for its sheet).
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { ApexAvatar } from '@/components/apex-avatar'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { cn } from '@/lib/utils'
import { $mainThread, $mainThreadsByProfile, type MainThreadState } from '@/store/main-thread'
import { notifyError } from '@/store/notifications'
import { $sessionStates } from '@/store/session-states'
import {
  $botLastSessions,
  $botRoster,
  $currentBotProfile,
  type ApexBot,
  openBot,
  requestBotCreate
} from '@/store/single-thread-bots'
import {
  $botSeenReplyIds,
  botUnread,
  latestReply,
  mainThreadState,
  markBotReplySeen,
  presenceOf,
  profileThread,
  type ThreadReply
} from '@/store/single-thread-presence'
import { $threadActivity, $threadInCall } from '@/store/thread-signals'

import { backgroundActivity } from './bot-activity'
import { SINGLE_THREAD_ROW_CLASS } from './sidebar-row'
import { BUSY_LINE_CLASS, useStatusLine } from './sidebar-status'

const ACTIVE_ROW_CLASS = 'bg-(--ui-row-active-background) shadow-xs hover:bg-(--ui-row-active-background)'

/** The round 「+」 beside search: asks for the new-assistant sheet. */
export function NewBotButton() {
  const copy = useSingleThreadSidebarCopy()

  return (
    <button
      aria-label={copy.newBot}
      className="grid size-8 place-items-center rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) text-(--ui-text-secondary) transition-colors [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
      data-single-thread-new-bot=""
      onClick={requestBotCreate}
      type="button"
    >
      <Codicon name="add" size="1rem" />
    </button>
  )
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

function BotRow({
  bot,
  current,
  onOpen,
  viewing
}: {
  bot: ApexBot
  current: boolean
  onOpen: () => void
  viewing: boolean
}) {
  const copy = useSingleThreadSidebarCopy()
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
  const preview = previewReply(thread, lastSessions[bot.profile])
  const presence = presenceOf(state, activity, current && inCall, reply ?? preview)
  const line = useStatusLine(presence)
  const seen = useStore($botSeenReplyIds)[bot.profile]
  const onScreen = current && viewing
  const unread = botUnread(reply, seen) && !onScreen

  // A reply counts as seen once this assistant's conversation is on screen with it in it.
  useEffect(() => {
    if (onScreen) {
      markBotReplySeen(bot.profile, reply?.id ?? null)
    }
  }, [bot.profile, onScreen, reply?.id])

  return (
    <button
      aria-current={current ? 'true' : undefined}
      className={cn(SINGLE_THREAD_ROW_CLASS, onScreen && ACTIVE_ROW_CLASS)}
      data-single-thread-bot={bot.profile}
      data-single-thread-nav="thread"
      data-state={presence.kind}
      onClick={onOpen}
      type="button"
    >
      <ApexAvatar
        className="size-[2.125rem]"
        color={bot.color}
        mood={presence.kind === 'working' ? 'working' : 'idle'}
        shape={bot.shape}
      />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[0.875rem] font-semibold text-(--ui-text-primary)">{bot.name}</span>
        {line ? (
          <span
            className={cn(
              'truncate pt-0.5 text-[0.75rem] text-(--ui-text-tertiary)',
              presence.kind !== 'idle' && BUSY_LINE_CLASS
            )}
            data-single-thread-status=""
          >
            {line}
          </span>
        ) : null}
      </span>
      {unread ? (
        <span aria-label={copy.unread} className="size-2 shrink-0 rounded-full bg-[#6A4CEB]" role="img" />
      ) : null}
    </button>
  )
}

export function SingleThreadBotRows({ onOpenCurrent, viewing }: { onOpenCurrent: () => void; viewing: boolean }) {
  const copy = useSingleThreadSidebarCopy()
  const roster = useStore($botRoster)
  const currentProfile = useStore($currentBotProfile)

  const open = (bot: ApexBot) => {
    if (bot.profile === currentProfile) {
      onOpenCurrent()

      return
    }

    // The switch drops to a fresh draft on `/` from any page; the shell then opens the thread.
    void openBot(bot.profile).catch((error: unknown) => notifyError(error, copy.openBotFailed(bot.name)))
  }

  return (
    <>
      {roster.map(bot => (
        <BotRow
          bot={bot}
          current={bot.profile === currentProfile}
          key={bot.profile}
          onOpen={() => open(bot)}
          viewing={viewing}
        />
      ))}
    </>
  )
}
