/**
 * hc-1014 单线对话: the sidebar in single-thread product mode. There is no
 * session list, no 新对话 / ⌘N row and no "+" (decisions 2 and 3). Developer
 * mode, and the switch off, render the full ChatSidebar.
 *
 * hc-1061 G3 draws it the way prototype v2 does, top to bottom:
 * - the APEX wordmark and a round search button (the command palette, which
 *   also finds earlier conversations);
 * - one assistant row: the avatar (hc-1064), 「APEX」, a status line (the latest
 *   reply, what it is doing, 等你决定, 通话中) and a dot for a reply not yet seen;
 * - 「在微信里找 APEX」, which opens the IM entry page;
 * - the account row: the name over 「快速 · 本月用了 18%」 (hc-1062).
 * hc-1070: there is no 「沉浸式分析」 here or in the account menu, and its
 * route turns back to the conversation (analysis-route-gate.tsx).
 *
 * hc-1077 (several assistants, `desktop_features.multi_bot`): one row per
 * assistant, APEX first (sidebar-bots.tsx), and a round 「+」 beside search.
 * Off, the sidebar is the one above, byte for byte.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'

import { ApexAvatar } from '@/components/apex-avatar'
import { Codicon } from '@/components/ui/codicon'
import { Sidebar, SidebarContent } from '@/components/ui/sidebar'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { cn } from '@/lib/utils'
import { BUSINESS_SIDEBAR_NAV_CONTRACT } from '@/store/business-workspace'
import { openCommandPalette } from '@/store/command-palette'
import { $panesFlipped } from '@/store/layout'
import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { useMultiBotMode } from '@/store/single-thread-bots'
import { $threadLatestReply, $threadPresence, $threadUnread, markThreadReplySeen } from '@/store/single-thread-presence'

import { DesktopUpdatePill } from '../chat/sidebar/desktop-update-pill'
import { type AppView, NEW_CHAT_ROUTE, sessionRoute } from '../routes'
import type { SidebarNavItem } from '../types'

import { SingleThreadAccountRow } from './sidebar-account'
import { NewBotButton, SingleThreadBotRows } from './sidebar-bots'
import { SINGLE_THREAD_ROW_CLASS } from './sidebar-row'
import { BUSY_LINE_CLASS, useStatusLine } from './sidebar-status'
import { SingleThreadWechatRow } from './sidebar-wechat'

function contractItem(id: 'projects' | 'scheduled-runs', icon: string): SidebarNavItem {
  const item = BUSINESS_SIDEBAR_NAV_CONTRACT.find(candidate => candidate.id === id)

  return {
    id,
    icon: (props: { className?: string }) => <Codicon name={icon} {...props} />,
    label: '',
    route: item?.route
  }
}

const ACCOUNT_MENU_ITEMS = {
  projects: contractItem('projects', 'folder'),
  'scheduled-runs': contractItem('scheduled-runs', 'calendar')
}

/** The conversation is the page on screen: the thread, or the empty thread on `/` before it exists. */
function useViewingThread(currentView: AppView): boolean {
  const thread = useStore($mainThread)
  const sessions = useStore($sessions)
  const selected = useStore($selectedStoredSessionId)

  return currentView === 'chat' && (!selected || isMainThreadStoredId(selected, thread, sessions))
}

function AssistantRow({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const chatCopy = useSingleThreadChatCopy()
  const copy = useSingleThreadSidebarCopy()
  const presence = useStore($threadPresence)
  const line = useStatusLine(presence)
  const unread = useStore($threadUnread) && !active

  return (
    <button
      className={cn(
        SINGLE_THREAD_ROW_CLASS,
        active && 'bg-(--ui-row-active-background) shadow-xs hover:bg-(--ui-row-active-background)'
      )}
      data-single-thread-nav="thread"
      data-state={presence.kind}
      onClick={onOpen}
      type="button"
    >
      <ApexAvatar className="size-[2.125rem]" mood={presence.kind === 'working' ? 'working' : 'idle'} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[0.875rem] font-semibold text-(--ui-text-primary)">
          {chatCopy.assistantName}
        </span>
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

export function SingleThreadSidebar({
  currentView,
  onNavigate
}: {
  currentView: AppView
  onNavigate: (item: SidebarNavItem) => void
}) {
  const copy = useSingleThreadSidebarCopy()
  const navigate = useNavigate()
  const thread = useStore($mainThread)
  const panesFlipped = useStore($panesFlipped)
  const multiBot = useMultiBotMode()
  const viewing = useViewingThread(currentView)
  const latestReply = useStore($threadLatestReply)

  // A reply counts as seen once the conversation is on screen with it in it.
  useEffect(() => {
    if (viewing) {
      markThreadReplySeen(latestReply?.id ?? null)
    }
  }, [viewing, latestReply?.id])

  const openThread = () =>
    navigate(thread.status === 'found' && thread.tipId ? sessionRoute(thread.tipId) : NEW_CHAT_ROUTE)

  const search = (
    <button
      aria-label={copy.search}
      className="grid size-8 place-items-center rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) text-(--ui-text-secondary) transition-colors [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
      data-single-thread-search=""
      onClick={openCommandPalette}
      type="button"
    >
      <Codicon name="search" size="1rem" />
    </button>
  )

  return (
    <Sidebar
      className={cn(
        'apex-primary-sidebar relative h-full min-w-0 overflow-hidden border-t-0 border-b-0 text-foreground transition-none',
        panesFlipped ? 'border-l border-r-0' : 'border-r border-l-0',
        'border-(--sidebar-edge-border) bg-(--ui-sidebar-surface-background) opacity-100'
      )}
      collapsible="none"
      data-apex-business-chrome=""
      data-apex-single-thread=""
    >
      <SidebarContent className="gap-0.5 overflow-hidden bg-transparent px-2 pb-3">
        <div
          className="flex h-[calc(var(--titlebar-height)+2.75rem)] shrink-0 items-end justify-between pb-3 pl-2.5 pr-0.5 [-webkit-app-region:drag]"
          data-apex-sidebar-brand=""
        >
          <span className="pb-1.5 text-[0.8125rem] font-bold tracking-[0.18em] text-(--ui-text-secondary)">APEX</span>
          {multiBot ? (
            <div className="flex items-center gap-1.5">
              <NewBotButton />
              {search}
            </div>
          ) : (
            search
          )}
        </div>
        {multiBot ? (
          <SingleThreadBotRows onOpenCurrent={openThread} viewing={viewing} />
        ) : (
          <AssistantRow active={viewing} onOpen={openThread} />
        )}
        <div className="min-h-0 flex-1" />
        <DesktopUpdatePill />
        <SingleThreadWechatRow />
        <SingleThreadAccountRow onNavigateBusiness={id => onNavigate(ACCOUNT_MENU_ITEMS[id])} />
      </SidebarContent>
    </Sidebar>
  )
}
