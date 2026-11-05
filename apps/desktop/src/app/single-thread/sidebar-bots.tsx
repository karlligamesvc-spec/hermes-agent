/**
 * hc-1077 多助手第一期 M1 (prototype v2 ⑥ Bots, ⑨ BotSwitch): the single-thread
 * sidebar's rows while several assistants are on (`desktop_features.multi_bot`).
 *
 * APEX first, always the purple circle; then each assistant the user made, in
 * the order they were made. A row is the assistant's face (its shape and
 * colour), its name, the same status line APEX's row has always had (the
 * latest reply, what it is doing, 等你决定, 通话中) and a dot for a reply not
 * yet seen (all decided in bot-status.ts). An assistant the user switched away
 * from keeps working in its own engine; its row follows it.
 *
 * A click on another assistant switches to it (store/single-thread-bots.ts
 * `openBot`) and the shell opens its 「APEX 主线」; a click on the one on
 * screen goes back to its conversation, as APEX's row did. Renaming, a new
 * look and deleting are hc-1078's (bot-manage.tsx): the 「+」 asks for its
 * sheet, and the row on screen carries its 「···」.
 *
 * hc-1146: a right-click on any row opens the same menu as the 「···」, in
 * Grok Bot's order and look (bot-row-menu.tsx). Pinned assistants come right
 * after APEX and wear a small pin; hidden ones leave the list for the
 * 「已隐藏」 row under it (sidebar-hidden-bots.tsx).
 */

import { useStore } from '@nanostores/react'
import { IconPinFilled } from '@tabler/icons-react'

import { ApexAvatar } from '@/components/apex-avatar'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
import { type SingleThreadSidebarCopy, useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { cn } from '@/lib/utils'
import { notify } from '@/store/notifications'
import {
  $botRoster,
  $currentBotProfile,
  $multiBotMax,
  type ApexBot,
  botFor,
  isBotPinned,
  openBot,
  requestBotCreate,
  sidebarBots
} from '@/store/single-thread-bots'

import { parsePoolAllBusy } from '../../../shared/apex-pool-busy'

import { type BotManage, CurrentBotRowFrame, useBotManage } from './bot-manage'
import { BotRowContextMenu } from './bot-row-menu'
import { useBotRowStatus } from './bot-status'
import { RowDot } from './row-dot'
import { HiddenBotsRow } from './sidebar-hidden-bots'
import { SINGLE_THREAD_ROW_CLASS } from './sidebar-row'
import { rowMood, statusLineClass } from './sidebar-status'

const ACTIVE_ROW_CLASS = 'bg-(--ui-row-active-background) shadow-xs hover:bg-(--ui-row-active-background)'

/**
 * The round 「+」 beside search: asks for the new-assistant sheet. At the limit it still opens it
 * (the sheet says to delete one first, hc-1078), and its label already says so.
 */
export function NewBotButton() {
  const copy = useSingleThreadSidebarCopy()
  const botsCopy = useSingleThreadBotsCopy()
  const max = useStore($multiBotMax)
  const full = useStore($botRoster).length >= max

  return (
    <button
      aria-label={full ? botsCopy.newBotFull(max) : copy.newBot}
      className="grid size-8 place-items-center rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) text-(--ui-text-secondary) transition-colors [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
      data-single-thread-new-bot={full ? 'full' : ''}
      onClick={requestBotCreate}
      type="button"
    >
      <Codicon name="add" size="1rem" />
    </button>
  )
}

/**
 * Why an assistant did not open, in words: every pooled engine busy with a
 * turn (hc-1080) names who is working; anything else says it could not be
 * opened. Never the engine's error text (that goes to the console). Both offer
 * to try again.
 */
function sayWhyNotOpened(error: unknown, bot: ApexBot, copy: SingleThreadSidebarCopy, retry: NotifyRetry): void {
  const busy = parsePoolAllBusy(error)?.busy ?? []
  const names = busy.map(profile => botFor($botRoster.get(), profile).name).join(copy.nameSeparator)

  console.warn(`[multi-bot] could not open ${bot.profile}`, error)
  notify({
    action: retry,
    kind: names ? 'warning' : 'error',
    message: names ? copy.allBusy(names) : copy.openBotFailed(bot.name)
  })
}

type NotifyRetry = { label: string; onClick: () => void }

function BotRow({
  bot,
  current,
  manage,
  onOpen,
  viewing
}: {
  bot: ApexBot
  current: boolean
  manage: BotManage
  onOpen: () => void
  viewing: boolean
}) {
  const onScreen = current && viewing
  const status = useBotRowStatus(bot, { current, onScreen })
  const menu = { bot, manage, status }
  const pinnedLabel = useSingleThreadBotsCopy().pinnedLabel
  const name = <span className="truncate text-[0.875rem] font-semibold text-(--ui-text-primary)">{bot.name}</span>

  const row = (
    <button
      aria-current={current ? 'true' : undefined}
      className={cn(SINGLE_THREAD_ROW_CLASS, onScreen && ACTIVE_ROW_CLASS)}
      data-single-thread-bot={bot.profile}
      data-single-thread-nav="thread"
      data-state={status.kind}
      onClick={onOpen}
      type="button"
    >
      <ApexAvatar className="size-[2.125rem]" color={bot.color} mood={rowMood(status.kind)} shape={bot.shape} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        {isBotPinned(bot) ? (
          <span className="flex min-w-0 items-center gap-1">
            {name}
            <IconPinFilled
              aria-label={pinnedLabel}
              className="size-3 shrink-0 text-(--ui-text-tertiary)"
              data-single-thread-bot-pinned=""
              role="img"
            />
          </span>
        ) : (
          name
        )}
        {status.line ? (
          <span
            className={cn('truncate pt-0.5 text-[0.75rem] text-(--ui-text-tertiary)', statusLineClass(status.kind))}
            data-single-thread-status=""
          >
            {status.line}
          </span>
        ) : null}
      </span>
      <RowDot unread={status.unread} waiting={status.kind === 'waiting' ? status.line : null} />
    </button>
  )

  return (
    <BotRowContextMenu {...menu}>
      {current ? <CurrentBotRowFrame menu={menu}>{row}</CurrentBotRowFrame> : row}
    </BotRowContextMenu>
  )
}

export function SingleThreadBotRows({ onOpenCurrent, viewing }: { onOpenCurrent: () => void; viewing: boolean }) {
  const copy = useSingleThreadSidebarCopy()
  const { t } = useI18n()
  const roster = useStore($botRoster)
  const currentProfile = useStore($currentBotProfile)

  const open = (bot: ApexBot) => {
    if (bot.profile === currentProfile) {
      onOpenCurrent()

      return
    }

    // hc-1146: straight into a thread this window knows, else a fresh draft the shell turns into
    // it; a cold engine says 「正在唤醒 <name>…」 once it has taken 400 ms.
    void openBot(bot.profile).catch((error: unknown) =>
      sayWhyNotOpened(error, bot, copy, { label: t.common.retry, onClick: () => open(bot) })
    )
  }

  const manage = useBotManage(open)
  const { hidden, shown } = sidebarBots(roster, currentProfile)

  return (
    <>
      {shown.map(bot => (
        <BotRow
          bot={bot}
          current={bot.profile === currentProfile}
          key={bot.profile}
          manage={manage}
          onOpen={() => open(bot)}
          viewing={viewing}
        />
      ))}
      <HiddenBotsRow bots={hidden} manage={manage} />
      {manage.layer}
    </>
  )
}
