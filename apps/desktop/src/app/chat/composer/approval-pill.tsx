import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { AlertTriangle, Check, ChevronDown, Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { applyApprovalMode, setSessionYolo } from '@/lib/yolo-session'
import { $activeSessionId, $approvalMode, $yoloActive, setYoloActive } from '@/store/session'

// Three-tier approval selector in the composer (hc-514). The runtime's
// approvals.mode already has three values; this pill exposes all three instead
// of the old binary review/full toggle:
//   manual → approvals.mode="manual": gate ONLY commands the runtime flags as
//            dangerous (tools/approval.py detect_dangerous_command). Honest copy
//            — this is NOT a Codex-style "ask on every external file write /
//            internet use"; that category gate doesn't exist yet (hc-514 b).
//   smart  → approvals.mode="smart": an assistant LLM weighs risk and asks.
//   full   → approvals.mode="off": unrestricted (the old binary yolo=1).
// The mapping is global + persistent because approvals.mode has no per-session
// form (only the binary $yoloActive session override does), so all three tiers
// necessarily write the global default. Backward compat: a legacy yolo=1
// reads back as approvals.mode="off" → the "full" tier here.
type ApprovalTier = 'full' | 'manual' | 'smart'

const TIERS = ['manual', 'smart', 'full'] as const

const TIER_ICON = { full: AlertTriangle, manual: Check, smart: Sparkles } as const

const PILL = cn(
  'h-(--composer-control-size) shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

export function ApprovalPill({ disabled }: { disabled: boolean }) {
  const t = useI18n().t.composer.approvalMode
  const { requestGateway } = useGatewayRequest()
  const yoloActive = useStore($yoloActive)
  const approvalMode = useStore($approvalMode)
  const sessionId = useStore($activeSessionId)
  const [open, setOpen] = useState(false)

  // "full" whenever approvals are effectively bypassed — either the global mode
  // is off, or a per-session yolo override (status-bar zap) is armed for this
  // chat. Otherwise reflect the global gating mode.
  const tier: ApprovalTier =
    yoloActive || approvalMode === 'off' ? 'full' : approvalMode === 'smart' ? 'smart' : 'manual'

  async function select(next: ApprovalTier) {
    setOpen(false)

    if (next === tier) {
      return
    }

    if (next === 'full') {
      await applyApprovalMode(requestGateway, 'off')

      return
    }

    // Switching to a gating tier: clear any per-session yolo override first so
    // the global gate actually applies to this chat instead of the pick
    // snapping straight back to "full".
    if (sessionId && yoloActive) {
      await setSessionYolo(requestGateway, sessionId, false).catch(() => setYoloActive(false))
    }

    await applyApprovalMode(requestGateway, next === 'smart' ? 'smart' : 'manual')
  }

  const TriggerIcon = TIER_ICON[tier]

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t.label}
          className={cn(PILL, tier === 'full' && 'text-amber-500 hover:text-amber-500')}
          disabled={disabled}
          title={t.label}
          type="button"
          variant="ghost"
        >
          <TriggerIcon className="size-3.5 shrink-0" />
          <span className="truncate">{t[tier].label}</span>
          <ChevronDown className="size-2.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      {/* Wide enough that each tier's one-line description never wraps. */}
      <DropdownMenuContent align="start" className="w-96" side="top" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={value => void select(value as ApprovalTier)} value={tier}>
          {TIERS.map(value => {
            const Icon = TIER_ICON[value]

            return (
              <DropdownMenuRadioItem className="items-start gap-2 py-1.5" key={value} value={value}>
                <Icon className="mt-0.5 size-4 shrink-0 text-(--ui-text-tertiary)" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-foreground">{t[value].label}</span>
                  <span className="text-(--ui-text-tertiary)">{t[value].desc}</span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
