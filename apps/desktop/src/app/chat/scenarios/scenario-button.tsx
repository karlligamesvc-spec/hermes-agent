import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { insertScenarioPrefill } from './pick'
import { ScenarioMenu } from './scenario-menu'
import { useScenarioCatalog } from './use-scenario-catalog'

// Matches the composer's other pills (ApprovalPill / ModelPill) so the ✦ button
// sits flush in the control row.
const PILL = cn(
  'h-(--composer-control-size) shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
  'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
)

/**
 * The composer's "✦ 场景" secondary entry (screen ②) — opens the searchable
 * two-level scenario menu; picking a scenario prefills the composer 口令 and
 * closes. Self-contained (reads the catalog + drives the composer via the
 * insert bus) so the composer only needs a single-line mount. Renders nothing
 * when the catalog is fleet-disabled.
 */
export function ScenarioButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  const catalog = useScenarioCatalog()
  const [open, setOpen] = useState(false)

  if (!catalog.enabled) {
    return null
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={t.scenarios.button}
          className={PILL}
          disabled={disabled}
          title={t.scenarios.button}
          type="button"
          variant="ghost"
        >
          <Sparkles className="size-3.5 shrink-0" />
          <span className="truncate">{t.scenarios.button}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0" side="top" sideOffset={8}>
        <ScenarioMenu
          catalog={catalog}
          onPick={item => {
            if (insertScenarioPrefill(item)) {
              triggerHaptic('selection')
              setOpen(false)
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
