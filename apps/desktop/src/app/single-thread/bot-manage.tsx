/**
 * hc-1078 (multi-bot M2): what the multi-bot sidebar (hc-1077 sidebar-bots.tsx) mounts to create,
 * rename / restyle and delete an assistant — the sheet behind its 「+」 (`$botCreateRequest`), the
 * 「···」 on the row on screen, and the delete confirmation. After each change the roster is read
 * again (hc-1077 `refreshBotRoster`); a new assistant is opened right away, and deleting the one on
 * screen goes back to APEX.
 *
 * What is open lives in the sidebar's own state, so it goes when the sidebar goes (developer mode,
 * the switch off) instead of reopening on the next mount.
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { notifyError } from '@/store/notifications'
import { requestOnApex } from '@/store/single-thread-bot-ops'
import {
  $botCreateRequest,
  $botRoster,
  $currentBotProfile,
  $multiBotMax,
  APEX_PROFILE,
  type ApexBot,
  openBot,
  refreshBotRoster
} from '@/store/single-thread-bots'

import { BotDeleteConfirm, type BotDeleteTarget } from './bot-delete-confirm'
import { BotRowMenu } from './bot-row-menu'
import { BotSheet, type BotSheetTarget } from './bot-sheet'

/** The row on screen with its 「···」 over the row's right edge (prototype ⑦); the row keeps room for it. */
export function CurrentBotRowFrame({
  bot,
  children,
  onDelete,
  onEdit
}: {
  bot: ApexBot
  children: ReactNode
  onDelete: () => void
  onEdit: () => void
}) {
  return (
    <div className="relative [&>[data-single-thread-bot]]:pr-10" data-single-thread-bot-frame="">
      {children}
      <div className="absolute top-1/2 right-1.5 -translate-y-1/2">
        <BotRowMenu bot={bot} onDelete={onDelete} onEdit={onEdit} />
      </div>
    </div>
  )
}

function refreshRoster(): Promise<unknown> {
  return refreshBotRoster(requestOnApex).catch(() => undefined)
}

export interface BotManage {
  edit: (bot: ApexBot) => void
  /** The sheet and the confirmation; render it once, beside the rows. */
  layer: ReactNode
  remove: (bot: ApexBot) => void
}

export function useBotManage(): BotManage {
  const sidebarCopy = useSingleThreadSidebarCopy()
  const roster = useStore($botRoster)
  const max = useStore($multiBotMax)
  const [sheet, setSheet] = useState<BotSheetTarget | null>(null)
  const [deleting, setDeleting] = useState<BotDeleteTarget | null>(null)

  // Each 「+」 press opens a fresh sheet; the count it starts from is not a press.
  useEffect(() => $botCreateRequest.listen(() => setSheet({ kind: 'new' })), [])

  const editing = sheet?.kind === 'edit' ? sheet.bot.profile : null
  const takenNames = roster.filter(bot => bot.profile !== editing).map(bot => bot.name)

  async function opened(profile: string) {
    await refreshRoster()
    const name = $botRoster.get().find(bot => bot.profile === profile)?.name ?? profile

    await openBot(profile).catch((error: unknown) => notifyError(error, sidebarCopy.openBotFailed(name)))
  }

  function deleted(profile: string) {
    const wasOnScreen = $currentBotProfile.get() === profile

    void refreshRoster()

    if (wasOnScreen) {
      void openBot(APEX_PROFILE).catch(() => undefined)
    }
  }

  const layer = (
    <>
      <BotSheet
        count={roster.length}
        max={max}
        onClose={() => setSheet(null)}
        onCreated={profile => void opened(profile)}
        onSaved={() => void refreshRoster()}
        takenNames={takenNames}
        target={sheet}
      />
      <BotDeleteConfirm onClose={() => setDeleting(null)} onDeleted={deleted} target={deleting} />
    </>
  )

  return {
    edit: bot => setSheet({ bot, kind: 'edit' }),
    layer,
    remove: bot => setDeleting({ name: bot.name, profile: bot.profile })
  }
}
