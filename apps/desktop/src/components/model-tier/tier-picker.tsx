import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { useModelTierCopy } from '@/i18n/model-tier'
import { Check, Loader2, Lock } from '@/lib/icons'
import { DEFAULT_MODEL_TIER, MODEL_TIER_LABEL, MODEL_TIERS, type ModelTier } from '@/lib/model-tiers'
import { cn } from '@/lib/utils'
import { useModelTierMaxOpen } from '@/store/model-tiers'

import {
  type ModelTierAvailability,
  type ModelTierCardState,
  modelTierCardState,
  useModelTierAvailability
} from './tier-availability'

export interface ModelTierPickerProps {
  /** Override the fetched availability (a caller that already holds it). */
  availability?: ModelTierAvailability
  className?: string
  disabled?: boolean
  /** Accessible name of the radio group; the section heading's text. */
  label?: string
  onChange: (tier: ModelTier) => void
  /** The tier being saved right now (spinner on that card). */
  saving?: ModelTier | null
  /** Render the "这个助手用哪一档" heading and the one-line intro above the
   *  cards — for a host (a plugin dialog) with no heading of its own. */
  showTitle?: boolean
  /** The assistant's tier; null = it runs on the user's own model service. */
  value: ModelTier | null
}

/**
 * Flash / Pro / Max cards — "这个助手用哪一档" (hc-960). Every assistant has
 * one tier; there is no model anywhere on this surface. A card the account
 * cannot use stays visible but greyed, says which plan opens it, and explains
 * itself when clicked instead of doing nothing.
 */
export function ModelTierPicker({
  availability: availabilityOverride,
  className,
  disabled = false,
  label,
  onChange,
  saving = null,
  showTitle = false,
  value
}: ModelTierPickerProps) {
  const copy = useModelTierCopy()
  const fetched = useModelTierAvailability(!availabilityOverride)
  const availability = availabilityOverride ?? fetched
  const maxOpen = useModelTierMaxOpen()
  const [notice, setNotice] = useState<null | string>(null)

  const availabilityNotice =
    availability.status === 'unknown'
      ? copy.availabilityUnknown
      : availability.status === 'not-ready'
        ? copy.serviceNotReady
        : null

  const explain = (tier: ModelTier, state: ModelTierCardState) => {
    const name = MODEL_TIER_LABEL[tier]

    if (state.kind === 'locked') {
      setNotice(copy.lockedNotice(name, state.plan === 'fast' ? copy.planFast : copy.planAdvanced))
    } else if (state.kind === 'coming-soon') {
      setNotice(copy.comingSoonNotice(name))
    } else if (state.kind === 'unavailable') {
      setNotice(availabilityNotice)
    }
  }

  const shownNotice = notice ?? availabilityNotice

  return (
    <div className={cn('@container grid gap-2.5', className)} data-testid="model-tier-picker">
      {showTitle ? (
        <div className="grid gap-1">
          <span className="text-xs font-medium text-foreground">{label ?? copy.sectionTitle}</span>
          <span className="text-[0.6875rem] leading-4 text-muted-foreground">{copy.intro}</span>
        </div>
      ) : null}
      {/* Three across when there is room (Settings); stacked in a narrow
          dialog, where three columns would wrap every badge. */}
      <div aria-label={label ?? copy.sectionTitle} className="grid gap-2 @lg:grid-cols-3" role="radiogroup">
        {MODEL_TIERS.map(tier => (
          <TierCard
            checked={value === tier}
            disabled={disabled || saving !== null}
            key={tier}
            onExplain={explain}
            onPick={next => {
              setNotice(null)

              if (next !== value) {
                onChange(next)
              }
            }}
            saving={saving === tier}
            state={modelTierCardState(tier, availability, maxOpen)}
            tier={tier}
          />
        ))}
      </div>
      {shownNotice ? (
        <p className="text-xs leading-5 text-muted-foreground" role="status">
          {shownNotice}
        </p>
      ) : null}
    </div>
  )
}

function TierCard({
  checked,
  disabled,
  onExplain,
  onPick,
  saving,
  state,
  tier
}: {
  checked: boolean
  disabled: boolean
  onExplain: (tier: ModelTier, state: ModelTierCardState) => void
  onPick: (tier: ModelTier) => void
  saving: boolean
  state: ModelTierCardState
  tier: ModelTier
}) {
  const copy = useModelTierCopy()
  const usable = state.kind === 'available'

  const badge =
    state.kind === 'locked'
      ? state.plan === 'fast'
        ? copy.lockedFast
        : copy.lockedAdvanced
      : state.kind === 'coming-soon'
        ? copy.comingSoon
        : tier === DEFAULT_MODEL_TIER
          ? copy.defaultBadge
          : null

  return (
    <button
      aria-checked={checked}
      aria-disabled={!usable || undefined}
      className={cn(
        'grid min-h-24 content-start gap-1 rounded-lg border px-3 py-2.5 text-left transition',
        checked
          ? 'border-primary/60 bg-primary/5'
          : usable
            ? 'border-(--ui-stroke-secondary) bg-background/55 hover:bg-accent/40'
            : 'border-dashed border-(--ui-stroke-tertiary) bg-transparent text-muted-foreground',
        disabled && 'opacity-60'
      )}
      data-state={state.kind}
      data-tier={tier}
      disabled={disabled}
      onClick={() => (usable ? onPick(tier) : onExplain(tier, state))}
      role="radio"
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn('text-sm font-semibold', usable ? 'text-foreground' : 'text-muted-foreground')}>
          {MODEL_TIER_LABEL[tier]}
        </span>
        {badge ? (
          <Badge size="xs" variant={usable ? 'success' : 'muted'}>
            {usable ? null : <Lock />}
            {badge}
          </Badge>
        ) : null}
        {saving ? (
          <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
        ) : checked ? (
          <Check className="ml-auto size-3.5 text-primary" />
        ) : null}
      </span>
      <span className={cn('text-xs font-medium', usable ? 'text-foreground' : 'text-muted-foreground')}>
        {copy.tiers[tier].tagline}
      </span>
      <span className="text-[0.6875rem] leading-4 text-muted-foreground">{copy.tiers[tier].fit}</span>
    </button>
  )
}
