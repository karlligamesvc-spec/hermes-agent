/**
 * hc-1078 (multi-bot M2): what the multi-bot sidebar (hc-1077 sidebar-bots.tsx) mounts to create,
 * rename / restyle and delete an assistant — the sheet behind its 「+」 (`$botCreateRequest`), the
 * 「···」 on the row on screen, and the delete confirmation. After each change the roster is read
 * again (hc-1077 `refreshBotRoster`); a new assistant is opened right away, and deleting the one on
 * screen goes back to APEX — both through the rows' own `open`, so a switch that fails says why
 * the same way a click on a row does (every engine busy, try again).
 *
 * What is open lives in the sidebar's own state, so it goes when the sidebar goes (developer mode,
 * the switch off) instead of reopening on the next mount.
 *
 * hc-1146 adds the row menu's 「置顶」 and 「从侧栏隐藏」 (and putting one back from 「已隐藏」): the
 * row moves at once, the flag is written to `ui_meta.apex`, and the roster is read again either way,
 * so a write that failed puts the row back where it was and says so. Hiding the assistant on screen
 * goes back to APEX, as deleting it does. A deleted or new assistant drops any 「标为未读」 left under
 * its profile name (`apex-bot-N` names come back).
 */

import { useStore } from '@nanostores/react'
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react'

import { useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
import { notify } from '@/store/notifications'
import { requestOnApex, saveBotSidebarFlags } from '@/store/single-thread-bot-ops'
import {
  $botCreateRequest,
  $botRoster,
  $currentBotProfile,
  $multiBotMax,
  APEX_PROFILE,
  type ApexBot,
  botFor,
  type BotSidebarFlags,
  patchBotSidebarFlags,
  refreshBotRoster
} from '@/store/single-thread-bots'
import { clearBotUnreadMark } from '@/store/single-thread-presence'

import { BotDeleteConfirm, type BotDeleteTarget } from './bot-delete-confirm'
import { BotRowMenu, type BotRowMenuProps } from './bot-row-menu'
import { BotSheet, type BotSheetTarget } from './bot-sheet'

/**
 * The row on screen with its 「···」 over the row's right edge (prototype ⑦); the row keeps room for it.
 * The rest of the props reach the frame: the row menu's right-click trigger (hc-1146) is put on it.
 */
export function CurrentBotRowFrame({
  children,
  menu,
  ...props
}: ComponentProps<'div'> & { children: ReactNode; menu: BotRowMenuProps }) {
  return (
    <div className="relative [&>[data-single-thread-bot]]:pr-10" data-single-thread-bot-frame="" {...props}>
      {children}
      <div className="absolute top-1/2 right-1.5 -translate-y-1/2">
        <BotRowMenu {...menu} />
      </div>
    </div>
  )
}

function refreshRoster(): Promise<unknown> {
  return refreshBotRoster(requestOnApex).catch(() => undefined)
}

export interface BotManage {
  edit: (bot: ApexBot) => void
  hide: (bot: ApexBot) => void
  /** The sheet and the confirmation; render it once, beside the rows. */
  layer: ReactNode
  remove: (bot: ApexBot) => void
  setPinned: (bot: ApexBot, pinned: boolean) => void
  /** Back into the sidebar from 「已隐藏」. */
  unhide: (bot: ApexBot) => void
}

/** `open` is the rows' switch (hc-1077 sidebar-bots.tsx): it opens an assistant and says why when it cannot. */
export function useBotManage(open: (bot: ApexBot) => void): BotManage {
  const copy = useSingleThreadBotsCopy()
  const roster = useStore($botRoster)
  const max = useStore($multiBotMax)
  const [sheet, setSheet] = useState<BotSheetTarget | null>(null)
  const [deleting, setDeleting] = useState<BotDeleteTarget | null>(null)

  // Each 「+」 press opens a fresh sheet; the count it starts from is not a press.
  useEffect(() => $botCreateRequest.listen(() => setSheet({ kind: 'new' })), [])

  const editing = sheet?.kind === 'edit' ? sheet.bot.profile : null
  const takenNames = roster.filter(bot => bot.profile !== editing).map(bot => bot.name)

  async function opened(profile: string) {
    clearBotUnreadMark(profile)
    await refreshRoster()
    open(botFor($botRoster.get(), profile))
  }

  function deleted(profile: string) {
    const wasOnScreen = $currentBotProfile.get() === profile

    clearBotUnreadMark(profile)
    void refreshRoster()

    if (wasOnScreen) {
      open(botFor($botRoster.get(), APEX_PROFILE))
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

  function saveFlags(bot: ApexBot, flags: BotSidebarFlags, saved?: () => void) {
    patchBotSidebarFlags(bot.profile, flags)
    saveBotSidebarFlags(bot.profile, flags)
      .then(saved, () => notify({ kind: 'error', message: copy.flagFailed }))
      .finally(() => void refreshRoster())
  }

  function hide(bot: ApexBot) {
    const wasOnScreen = $currentBotProfile.get() === bot.profile

    saveFlags(bot, { hidden: true }, () => notify({ kind: 'info', message: copy.hiddenNotice(bot.name) }))

    if (wasOnScreen) {
      open(botFor($botRoster.get(), APEX_PROFILE))
    }
  }

  return {
    edit: bot => setSheet({ bot, kind: 'edit' }),
    hide,
    layer,
    remove: bot => setDeleting({ name: bot.name, profile: bot.profile }),
    setPinned: (bot, pinned) => saveFlags(bot, { pinned }),
    unhide: bot => saveFlags(bot, { hidden: false })
  }
}
