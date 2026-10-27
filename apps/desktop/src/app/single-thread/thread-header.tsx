/**
 * hc-1014 单线对话: the header over the one thread — a pill with APEX's avatar
 * (hc-1064) and name, nothing else. No session title, no pin / rename / delete menu: there
 * is one conversation and it is not managed like a session. Its status goes in
 * the activity line at the foot of the conversation (hc-1015), not here. An
 * earlier conversation keeps today's header, title included, so it reads as an
 * old chat. The name is the default 「APEX」 (decision 4); renaming it in one
 * sentence is a later piece. hc-1077: with several assistants on, the pill is
 * the assistant on screen — its face and its name.
 */

import { useStore } from '@nanostores/react'

import { ApexAvatar } from '@/components/apex-avatar'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { cn } from '@/lib/utils'
import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $sessions } from '@/store/session'
import { useSingleThreadMode } from '@/store/single-thread'
import { useBotLook, useBotName } from '@/store/single-thread-bots'

import { titlebarHeaderBaseClass } from '../shell/titlebar'

/** Does the primary chat on screen (the thread, or the empty thread before it exists) wear the pill? */
export function useSingleThreadHeader(selectedStoredSessionId: null | string): boolean {
  const singleThread = useSingleThreadMode()
  const thread = useStore($mainThread)
  const sessions = useStore($sessions)

  return singleThread && (!selectedStoredSessionId || isMainThreadStoredId(selectedStoredSessionId, thread, sessions))
}

export function SingleThreadHeader() {
  const copy = useSingleThreadChatCopy()
  const name = useBotName() ?? copy.assistantName
  const look = useBotLook()

  return (
    <header className={cn(titlebarHeaderBaseClass, 'justify-center')} data-single-thread-header="">
      <div
        aria-label={name}
        className="flex min-w-0 items-center gap-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) py-0.5 pl-0.5 pr-3 shadow-xs"
      >
        <ApexAvatar className="size-[1.625rem]" {...look} />
        <span className="truncate text-[0.875rem] font-semibold text-(--ui-text-primary)">{name}</span>
      </div>
    </header>
  )
}
