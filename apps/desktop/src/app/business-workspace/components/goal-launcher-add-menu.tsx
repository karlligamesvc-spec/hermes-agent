import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useComposerSimpleCopy } from '@/i18n/composer-simple'

import { AttachRows, type ComposerPickers } from '../../chat/composer/context-menu-advanced'

/** The Start input's workflow choice: what the button says and does. */
export interface GoalLauncherWorkflow {
  disabled: boolean
  label: string
  onChoose: () => void
}

/**
 * The Start input's "+": the attach rows and — outside developer mode, where
 * the workflow button leaves the footer (attach · voice · send; the prototype's
 * "不用选工作流") — a 高级 fold holding the workflow choice, so it is one level
 * down rather than gone.
 */
export function GoalLauncherAddMenu({
  disabled,
  pickers,
  workflow
}: {
  disabled: boolean
  pickers: ComposerPickers
  workflow?: GoalLauncherWorkflow
}) {
  const copy = useComposerSimpleCopy()
  const canAttach = Boolean(pickers.onPickFiles || pickers.onPickFolders || pickers.onPickImages)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={copy.addMenu}
          disabled={disabled || !(canAttach || workflow)}
          size="icon-sm"
          title={copy.addMenu}
          type="button"
          variant="ghost"
        >
          <Codicon name="add" size="0.875rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <AttachRows {...pickers} />
        {workflow && (
          <>
            {canAttach && <DropdownMenuSeparator />}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-slot="composer-advanced">
                <Codicon name="settings" size="0.875rem" />
                <span className="min-w-0 flex-1 truncate">{copy.advanced}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem disabled={workflow.disabled} onSelect={workflow.onChoose}>
                  <Codicon name="workflow" size="0.875rem" />
                  <span className="truncate">{workflow.label}</span>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
