import { useAuiState, useMessageRuntime } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'

import { useSessionView } from '@/app/chat/session-view'
import { Button } from '@/components/ui/button'
import { useModelTierCopy } from '@/i18n/model-tier'
import { triggerHaptic } from '@/lib/haptics'
import { Sparkles } from '@/lib/icons'
import {
  assistantModelChoice,
  MODEL_TIER_LABEL,
  type ModelTier,
  nextModelTier,
  retryTierReloadConfig
} from '@/lib/model-tiers'
import { useModelTierMaxOpen, useModelTierMode } from '@/store/model-tiers'

import { type ModelTierAvailability, modelTierCardState, useModelTierAvailability } from './tier-availability'

/** The tier "换更强的再答一次" moves to, or null when there is none to offer:
 *  the chat runs on the user's own model, is already on Max, or the account
 *  cannot use the next tier (a locked tier is never offered as a retry). */
export function retryStrongerTier(
  model: string,
  provider: string,
  availability: ModelTierAvailability,
  maxOpen: boolean
): ModelTier | null {
  const choice = assistantModelChoice(model, provider)

  if (choice.kind !== 'tier') {
    return null
  }

  const next = nextModelTier(choice.tier)

  return next && modelTierCardState(next, availability, maxOpen).kind === 'available' ? next : null
}

/**
 * "换更强的再答一次" under the latest answer (hc-960): re-run this turn one
 * tier up. The tier rides the existing regenerate path as reload run config;
 * the chat stays on the stronger tier afterwards, the assistant's own tier in
 * its settings does not change.
 *
 * Mounted on every assistant message, so off tier mode it costs one store read
 * and renders nothing — the entitlement query only exists in tier mode.
 */
export function RetryStrongerButton() {
  return useModelTierMode() ? <TierRetry /> : null
}

function TierRetry() {
  const copy = useModelTierCopy()
  const maxOpen = useModelTierMaxOpen()
  const availability = useModelTierAvailability()
  const view = useSessionView()
  const model = useStore(view.$model)
  const provider = useStore(view.$provider)
  const isLast = useAuiState(s => s.message.isLast)
  const threadRunning = useAuiState(s => s.thread.isRunning)
  const messageRuntime = useMessageRuntime()

  if (!isLast || threadRunning) {
    return null
  }

  const next = retryStrongerTier(model, provider, availability, maxOpen)

  if (!next) {
    return null
  }

  return (
    <Button
      className="h-6 gap-1 px-1.5 text-[0.6875rem] font-medium text-muted-foreground hover:text-foreground"
      data-retry-tier={next}
      onClick={() => {
        triggerHaptic('submit')
        messageRuntime.reload(retryTierReloadConfig(next))
      }}
      size="xs"
      title={copy.retryStrongerTip(MODEL_TIER_LABEL[next])}
      type="button"
      variant="ghost"
    >
      <Sparkles className="size-3" />
      {copy.retryStronger}
    </Button>
  )
}
