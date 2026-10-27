/**
 * hc-1078 (multi-bot M2): the 「···」 on the selected sidebar row, as prototype v2 artboard ⑦ draws
 * it: 「改名或换样子」 and, in red, 「删除这个助手」. APEX's row offers 「改名」 only: it cannot be
 * deleted and its look is fixed (K6).
 */

import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'

export function BotRowMenu({
  isApex,
  name,
  onDelete,
  onEdit
}: {
  isApex: boolean
  name: string
  onDelete: () => void
  onEdit: () => void
}) {
  const copy = useSingleThreadBotsCopy()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={copy.more(name)}
          className="grid size-7 place-items-center rounded-lg text-(--ui-text-secondary) [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
          data-single-thread-bot-more=""
          type="button"
        >
          <Codicon name="ellipsis" size="1rem" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuItem data-bot-menu="edit" onSelect={onEdit}>
          {isApex ? copy.rename : copy.edit}
        </DropdownMenuItem>
        {isApex ? null : (
          <DropdownMenuItem data-bot-menu="delete" onSelect={onDelete} variant="destructive">
            {copy.remove}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
