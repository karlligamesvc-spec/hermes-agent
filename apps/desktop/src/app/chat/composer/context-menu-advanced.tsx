import type { ReactNode } from 'react'

import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useComposerSimpleCopy } from '@/i18n/composer-simple'
import { AudioLines, ShieldLock, Sparkles } from '@/lib/icons'

import { ApprovalTierItems, useApprovalTier } from './approval-pill'
import { VoiceMenuItems, type VoiceMenuItemsProps } from './voice-menu'

/** The composer's attachment pickers; a missing one hides its row. */
export interface ComposerPickers {
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
}

/** What the 高级 fold needs from the composer that owns it. */
export interface ComposerAdvanced {
  /** hc-1015 single-thread mode: no approval picker here. The mode stays as
   *  set, every approval still asks, and the status bar keeps the ⚡ item
   *  while approvals are off. */
  hideApprovals?: boolean
  /** Absent while the scenario catalog is switched off, and in single-thread mode. */
  onOpenScenarios?: () => void
  voice: VoiceMenuItemsProps
}

const ROW = 'text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)'

/**
 * "附件" in attach · voice · send: images ride the vision path, files and
 * videos become `@file:` context, a folder becomes `@folder:`. Drag and drop
 * and paste still do the same; the rows are for people who don't know that.
 */
export function AttachRows({ onPickFiles, onPickFolders, onPickImages }: ComposerPickers) {
  const copy = useComposerSimpleCopy()

  return (
    <>
      {onPickImages && (
        <DropdownMenuItem className={ROW} onSelect={onPickImages}>
          <Codicon name="file-media" size="0.875rem" />
          <span>{copy.addImages}</span>
        </DropdownMenuItem>
      )}
      {onPickFiles && (
        <DropdownMenuItem className={ROW} onSelect={onPickFiles}>
          <Codicon name="file" size="0.875rem" />
          <span>{copy.addFiles}</span>
        </DropdownMenuItem>
      )}
      {onPickFolders && (
        <DropdownMenuItem className={ROW} onSelect={onPickFolders}>
          <Codicon name="folder-opened" size="0.875rem" />
          <span>{copy.addFolder}</span>
        </DropdownMenuItem>
      )}
    </>
  )
}

/**
 * 高级: everything the everyday composer leaves out — scenarios, approvals,
 * voice settings — ahead of whatever the caller folds in after them (the
 * menu's skill and connector rows). Every function the old toolbar offered is
 * still one level down; none is gone. No model choice lives here: on an APEX
 * account the tier sits in each assistant's settings (hc-960), and the
 * user's-own-key model pill keeps its place in the row.
 */
export function AdvancedSubmenu({ advanced, children }: { advanced: ComposerAdvanced; children: ReactNode }) {
  const copy = useComposerSimpleCopy()

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={ROW} data-slot="composer-advanced">
        <Codicon name="settings" size="0.875rem" />
        <span className="min-w-0 flex-1 truncate">{copy.advanced}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {advanced.onOpenScenarios && (
          <DropdownMenuItem className={ROW} onSelect={advanced.onOpenScenarios}>
            <Sparkles />
            <span>{copy.scenarios}</span>
          </DropdownMenuItem>
        )}
        {!advanced.hideApprovals && <ApprovalSubmenu />}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={ROW}>
            <AudioLines />
            <span className="min-w-0 flex-1 truncate">{copy.voiceSettings}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-52">
            <VoiceMenuItems {...advanced.voice} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function ApprovalSubmenu() {
  const copy = useComposerSimpleCopy()
  const { select, tier } = useApprovalTier()

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={ROW}>
        <ShieldLock />
        <span className="min-w-0 flex-1 truncate">{copy.approval}</span>
      </DropdownMenuSubTrigger>
      {/* Wide enough that each tier's one-line description never wraps. */}
      <DropdownMenuSubContent className="w-96">
        <ApprovalTierItems onSelect={next => void select(next)} tier={tier} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
