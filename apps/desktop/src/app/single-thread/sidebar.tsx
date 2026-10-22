/**
 * hc-1014 单线对话: the sidebar in single-thread product mode. One row opens
 * the conversation; there is no session list, no 新对话 / ⌘N row and no "+"
 * (decisions 2 and 3). Analysis keeps its row, and the account menu keeps
 * Profile, Settings and the other destinations, with 「更早的对话」 in place of
 * 历史会话. Developer mode, and the switch off, render the full ChatSidebar.
 */

import { useStore } from '@nanostores/react'
import { useNavigate } from 'react-router'

import { BrandMark } from '@/components/brand-mark'
import { Codicon } from '@/components/ui/codicon'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import { useI18n } from '@/i18n'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { cn } from '@/lib/utils'
import { BUSINESS_SIDEBAR_NAV_CONTRACT } from '@/store/business-workspace'
import { $panesFlipped } from '@/store/layout'
import { $mainThread } from '@/store/main-thread'

import { AccountPanel } from '../chat/sidebar/account-panel'
import { DesktopUpdatePill } from '../chat/sidebar/desktop-update-pill'
import { type AppView, NEW_CHAT_ROUTE, sessionRoute } from '../routes'
import type { SidebarNavItem } from '../types'

const ROW_CLASS =
  'flex h-8 w-full justify-start gap-2.5 rounded-[0.625rem] border border-transparent px-2.5 text-left text-[0.8125rem] font-medium text-(--ui-text-secondary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none'

const ROW_ACTIVE_CLASS =
  'border-transparent bg-(--ui-row-active-background) text-foreground shadow-none hover:bg-(--ui-row-active-background)!'

function contractItem(id: 'analysis' | 'projects' | 'scheduled-runs', icon: string): SidebarNavItem {
  const item = BUSINESS_SIDEBAR_NAV_CONTRACT.find(candidate => candidate.id === id)

  return {
    id,
    icon: (props: { className?: string }) => <Codicon name={icon} {...props} />,
    label: '',
    route: item?.route
  }
}

const ANALYSIS_ITEM = contractItem('analysis', 'book')

const ACCOUNT_MENU_ITEMS = {
  projects: contractItem('projects', 'folder'),
  'scheduled-runs': contractItem('scheduled-runs', 'calendar')
}

export function SingleThreadSidebar({
  currentView,
  onNavigate
}: {
  currentView: AppView
  onNavigate: (item: SidebarNavItem) => void
}) {
  const { t } = useI18n()
  const copy = useSingleThreadChatCopy()
  const navigate = useNavigate()
  const thread = useStore($mainThread)
  const panesFlipped = useStore($panesFlipped)

  const openThread = () =>
    navigate(thread.status === 'found' && thread.tipId ? sessionRoute(thread.tipId) : NEW_CHAT_ROUTE)

  const rows = [
    {
      active: currentView === 'chat',
      icon: 'comment-discussion',
      id: 'thread',
      label: copy.thread,
      onClick: openThread
    },
    {
      active: currentView === 'analysis',
      icon: 'book',
      id: 'analysis',
      label: t.sidebar.nav.analysis ?? '',
      onClick: () => onNavigate(ANALYSIS_ITEM)
    }
  ]

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
      <SidebarContent className="gap-0 overflow-hidden bg-transparent px-2.5">
        <div
          aria-label="APEX"
          className="flex h-[calc(var(--titlebar-height)+2.75rem)] shrink-0 items-end gap-2.5 px-2.5 pb-2.5 [-webkit-app-region:drag]"
          data-apex-sidebar-brand=""
        >
          <BrandMark aria-hidden="true" className="size-5 rounded-[0.3rem]" />
          <span className="pb-px text-[0.875rem] font-semibold tracking-[0.2em] text-(--ui-text-primary)">APEX</span>
        </div>
        <SidebarGroup className="shrink-0 p-0 pb-2 pt-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              {rows.map(row => (
                <SidebarMenuItem key={row.id}>
                  <SidebarMenuButton
                    className={cn(ROW_CLASS, row.active && ROW_ACTIVE_CLASS)}
                    data-single-thread-nav={row.id}
                    onClick={row.onClick}
                    type="button"
                  >
                    <Codicon
                      className="size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]"
                      name={row.icon}
                    />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <div className="min-h-0 flex-1" />
        <div className="shrink-0 px-0.5 pb-1 pt-0.5">
          <DesktopUpdatePill />
          <AccountPanel businessChrome onNavigateBusiness={id => onNavigate(ACCOUNT_MENU_ITEMS[id])} />
        </div>
      </SidebarContent>
    </Sidebar>
  )
}
