import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Slot as ContribSlot } from '@/contrib/react/slot'
import { cn } from '@/lib/utils'
import { $singleThreadMode } from '@/store/single-thread'
import { $toolViewMode } from '@/store/tool-view'

import { ScenarioButton, ScenarioPicker } from '../scenarios/scenario-button'
import { useScenarioCatalog } from '../scenarios/use-scenario-catalog'

import { ApprovalPill } from './approval-pill'
import { ContextMenu } from './context-menu'
import type { ComposerPickers } from './context-menu-advanced'
import { COMPOSER_AREAS } from './contrib'
import type { ChatBarState } from './types'
import type { VoiceMenuItemsProps } from './voice-menu'

/**
 * The leading side of the composer row. The everyday composer is attach ·
 * voice · send (WP4, Kael 2026-10-20), so here that is the "+" alone: its
 * 高级 row holds scenarios, approvals and voice settings, and 场景 opens the
 * same picker the ✦ pill did, anchored to this row. Developer mode keeps the
 * row as it was — ✦ 场景 and 审批 inline, the "+" menu flat — for whoever
 * works on those controls or wants them one click away.
 */
export function ComposerToolbarStart({
  disabled,
  pickers,
  stackToolbar,
  state,
  voice
}: {
  disabled: boolean
  pickers: ComposerPickers
  stackToolbar: boolean
  state: ChatBarState
  voice: VoiceMenuItemsProps
}) {
  const developer = useStore($toolViewMode) === 'technical'
  // hc-1015: single-thread mode picks no scenario and no approval mode here.
  const singleThread = useStore($singleThreadMode)
  const catalog = useScenarioCatalog()
  const [scenariosOpen, setScenariosOpen] = useState(false)
  const scenariosAvailable = catalog.enabled && !disabled && !singleThread

  return (
    <Popover onOpenChange={setScenariosOpen} open={scenariosOpen}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            'flex items-center gap-(--composer-control-gap) [grid-area:menu]',
            !stackToolbar && 'translate-y-[3px] self-start'
          )}
          data-slot="composer-toolbar-start"
        >
          <ContextMenu
            advanced={
              developer
                ? undefined
                : {
                    hideApprovals: singleThread,
                    onOpenScenarios: scenariosAvailable ? () => setScenariosOpen(true) : undefined,
                    voice,
                    voiceOnly: singleThread
                  }
            }
            pickers={pickers}
            state={state}
          />
          {developer && <ScenarioButton disabled={disabled} />}
          {developer && <ApprovalPill disabled={disabled} />}
          <ContribSlot area={COMPOSER_AREAS.leading} />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0" side="top" sideOffset={8}>
        <ScenarioPicker catalog={catalog} onPicked={() => setScenariosOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
