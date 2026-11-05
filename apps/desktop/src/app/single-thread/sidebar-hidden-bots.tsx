/**
 * hc-1146: the quiet row under the assistants while some are hidden from the sidebar (「从侧栏隐藏」 in
 * the row menu). It says how many, shows each hidden assistant's face — with its dot when a reply
 * came in or it waits on the user, so a hidden one is never silently stuck — and opens a menu in the
 * row menu's look: picking an assistant puts it back in the sidebar.
 *
 * Hidden is the sidebar's business only: the assistant keeps working, relays still reach it, its
 * notifications still come, and opening it from one of them shows its row while it is on screen
 * (store/single-thread-bots.ts `sidebarBots`).
 */

import { IconEyeOff } from '@tabler/icons-react'

import { ApexAvatar } from '@/components/apex-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
import type { ApexBot } from '@/store/single-thread-bots'

import type { BotManage } from './bot-manage'
import { BOT_MENU_CLASS, BOT_MENU_ITEM_CLASS } from './bot-row-menu'
import { useBotRowStatus } from './bot-status'
import { RowDot } from './row-dot'
import { rowMood } from './sidebar-status'

/** A hidden assistant's small face, with the row's own dot. */
function HiddenBotFace({ bot }: { bot: ApexBot }) {
  const status = useBotRowStatus(bot, { current: false, onScreen: false })

  return (
    <span className="flex items-center gap-0.5" data-hidden-bot-face={bot.profile}>
      <ApexAvatar className="size-4" color={bot.color} mood={rowMood(status.kind)} shape={bot.shape} />
      <RowDot unread={status.unread} waiting={status.kind === 'waiting' ? status.line : null} />
    </span>
  )
}

export function HiddenBotsRow({ bots, manage }: { bots: readonly ApexBot[]; manage: BotManage }) {
  const copy = useSingleThreadBotsCopy()

  if (bots.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="mt-0.5 flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-[0.75rem] text-(--ui-text-tertiary) transition-colors [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
          data-single-thread-hidden-bots=""
          type="button"
        >
          <IconEyeOff aria-hidden className="size-3.5 shrink-0" stroke={1.75} />
          <span className="min-w-0 flex-1 truncate">{copy.hiddenRow(bots.length)}</span>
          <span className="flex shrink-0 items-center gap-1">
            {bots.map(bot => (
              <HiddenBotFace bot={bot} key={bot.profile} />
            ))}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={BOT_MENU_CLASS} sideOffset={4}>
        <DropdownMenuLabel className="px-2.5 py-1 text-[0.75rem] font-normal text-(--ui-text-tertiary)">
          {copy.hiddenMenuLabel}
        </DropdownMenuLabel>
        {bots.map(bot => (
          <DropdownMenuItem
            className={BOT_MENU_ITEM_CLASS}
            data-hidden-bot={bot.profile}
            key={bot.profile}
            onSelect={() => manage.unhide(bot)}
          >
            <ApexAvatar className="size-[1.125rem]" color={bot.color} shape={bot.shape} />
            <span className="truncate">{bot.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
