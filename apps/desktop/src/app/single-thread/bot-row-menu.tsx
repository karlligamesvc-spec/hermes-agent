/**
 * hc-1078 (multi-bot M2) put a 「···」 on the selected sidebar row with 「改名或换样子」 and, in red,
 * 「删除这个助手」 (prototype v2 artboard ⑦).
 *
 * hc-1146 makes it Grok Bot's row menu, one list of items (components/ui/actions-menu.tsx) behind
 * every row's right-click and the 「···」 alike, in Grok's order and look — an icon on each item,
 * groups split by a line, delete last in red:
 *
 *   置顶 · 标为未读 | 改名 | 复制对话 ID | 从侧栏隐藏 · 删除这个助手
 *
 * Grok's 「Move to new section」 has no counterpart: the sidebar has no groups. APEX's menu keeps what
 * applies to it (K6: it cannot be deleted and its look is fixed; it is always first and always
 * shown): 标为未读, 改名, 复制对话 ID.
 */

import { useStore } from '@nanostores/react'
import {
  IconCopy,
  IconEdit,
  IconEyeOff,
  IconMail,
  IconMailOpened,
  IconPin,
  IconPinnedOff,
  IconTrash,
  type TablerIcon
} from '@tabler/icons-react'
import type { ReactNode } from 'react'

import { ActionsContextMenu, ActionsMenu, type MenuKit } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import { writeClipboardText } from '@/components/ui/copy-button'
import { type SingleThreadBotsCopy, useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
import { $mainThread, $mainThreadsByProfile } from '@/store/main-thread'
import { notify } from '@/store/notifications'
import { type ApexBot, canDeleteBot, canRestyleBot, isBotPinned } from '@/store/single-thread-bots'
import { markBotRead, markBotUnread, profileThread } from '@/store/single-thread-presence'

import type { BotManage } from './bot-manage'

/** Grok's menu: roomier than the app's compact menus, with full-width lines between groups. */
export const BOT_MENU_CLASS = 'min-w-[13rem] rounded-xl p-1.5 shadow-lg'
export const BOT_MENU_ITEM_CLASS = 'gap-2.5 rounded-lg px-2.5 py-1.5 text-[0.875rem] leading-5'
const ICON_CLASS = 'size-[1.125rem] text-(--ui-text-secondary)'
const SEPARATOR_CLASS = '-mx-1.5 my-1'

export interface BotRowMenuProps {
  bot: ApexBot
  manage: BotManage
  /** The row's dot (bot-status.ts): lit, the item reads 「标为已读」 and counts `replyId` as seen. */
  status: { replyId: null | string; unread: boolean }
}

interface MenuItemSpec {
  disabled?: boolean
  icon: TablerIcon
  key: string
  label: string
  onSelect: () => void
  variant?: 'default' | 'destructive'
}

function copyConversationId(id: null | string, copy: SingleThreadBotsCopy): void {
  if (!id) {
    return
  }

  writeClipboardText(id)
    .then(() => notify({ durationMs: 2_000, kind: 'success', message: copy.copiedId }))
    .catch(() => notify({ kind: 'error', message: copy.copyIdFailed }))
}

/** The live id of the assistant's 「APEX 主线」 (as this window last read it); null while it has none yet. */
function useConversationId(profile: string): null | string {
  const thread = profileThread(profile, useStore($mainThread), useStore($mainThreadsByProfile))

  return thread?.status === 'found' ? (thread.tipId ?? thread.rootId) : null
}

/** The menu's groups, top to bottom; an empty group draws no line. */
function menuGroups(
  { bot, manage, status }: BotRowMenuProps,
  conversationId: null | string,
  copy: SingleThreadBotsCopy
): MenuItemSpec[][] {
  const pinned = isBotPinned(bot)

  const readState: MenuItemSpec = status.unread
    ? {
        icon: IconMailOpened,
        key: 'read',
        label: copy.markRead,
        onSelect: () => markBotRead(bot.profile, status.replyId)
      }
    : { icon: IconMail, key: 'unread', label: copy.markUnread, onSelect: () => markBotUnread(bot.profile) }

  const pin: MenuItemSpec = {
    icon: pinned ? IconPinnedOff : IconPin,
    key: pinned ? 'unpin' : 'pin',
    label: pinned ? copy.unpin : copy.pin,
    onSelect: () => manage.setPinned(bot, !pinned)
  }

  const removable = canDeleteBot(bot)

  const groups: MenuItemSpec[][] = [
    removable ? [pin, readState] : [readState],
    [
      {
        icon: IconEdit,
        key: 'edit',
        label: canRestyleBot(bot) ? copy.edit : copy.rename,
        onSelect: () => manage.edit(bot)
      }
    ],
    [
      {
        disabled: !conversationId,
        icon: IconCopy,
        key: 'copy-id',
        label: copy.copyId,
        onSelect: () => copyConversationId(conversationId, copy)
      }
    ],
    removable
      ? [
          { icon: IconEyeOff, key: 'hide', label: copy.hide, onSelect: () => manage.hide(bot) },
          {
            icon: IconTrash,
            key: 'delete',
            label: copy.remove,
            onSelect: () => manage.remove(bot),
            variant: 'destructive'
          }
        ]
      : []
  ]

  return groups.filter(group => group.length > 0)
}

function useBotMenuItems(props: BotRowMenuProps): (kit: MenuKit) => ReactNode {
  const copy = useSingleThreadBotsCopy()
  const groups = menuGroups(props, useConversationId(props.bot.profile), copy)

  return kit =>
    groups.map((group, index) => <BotMenuGroup first={index === 0} group={group} key={group[0].key} kit={kit} />)
}

function BotMenuGroup({ first, group, kit }: { first: boolean; group: MenuItemSpec[]; kit: MenuKit }) {
  return (
    <>
      {first ? null : <kit.Separator className={SEPARATOR_CLASS} />}
      {group.map(({ disabled, icon: Icon, key, label, onSelect, variant }) => (
        <kit.Item
          className={BOT_MENU_ITEM_CLASS}
          data-bot-menu={key}
          disabled={disabled}
          key={key}
          onSelect={onSelect}
          variant={variant}
        >
          <Icon aria-hidden className={ICON_CLASS} stroke={1.75} />
          <span>{label}</span>
        </kit.Item>
      ))}
    </>
  )
}

/** The 「···」 over the row on screen (hc-1078): the same menu as a right-click. */
export function BotRowMenu(props: BotRowMenuProps) {
  const copy = useSingleThreadBotsCopy()
  const items = useBotMenuItems(props)

  return (
    <ActionsMenu align="start" contentClassName={BOT_MENU_CLASS} items={items} sideOffset={4}>
      <button
        aria-label={copy.more(props.bot.name)}
        className="grid size-7 place-items-center rounded-lg text-(--ui-text-secondary) [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
        data-single-thread-bot-more=""
        type="button"
      >
        <Codicon name="ellipsis" size="1rem" />
      </button>
    </ActionsMenu>
  )
}

/** Right-click anywhere on a row (hc-1146); the app's window menu no longer answers there. */
export function BotRowContextMenu({ children, ...props }: BotRowMenuProps & { children: ReactNode }) {
  const copy = useSingleThreadBotsCopy()
  const items = useBotMenuItems(props)

  return (
    <ActionsContextMenu ariaLabel={copy.more(props.bot.name)} contentClassName={BOT_MENU_CLASS} items={items}>
      {children}
    </ActionsContextMenu>
  )
}
