import type { ModelOptionProvider } from '@hermes/shared'
import { useQuery } from '@tanstack/react-query'

import { getGlobalModelOptions } from '@/hermes'
import { availableModelTiers, DEFAULT_MODEL_TIER, MODEL_TIER_UNLOCK_PLAN, type ModelTier } from '@/lib/model-tiers'
import { isManagedProviderSlug } from '@/lib/provider-allowlist'

/**
 * Which tiers this account may use (hc-960). The relay lists exactly the
 * models a plan is entitled to (`GET /v1/models`); the runtime surfaces that
 * list as the managed provider's `models`. A tier is usable when its alias is
 * in it — no plan code is read here.
 */
export type ModelTierAvailability =
  | { status: 'loading' }
  /** The list could not be read (backend down, no managed row). */
  | { status: 'unknown' }
  /** The relay answered but serves no tier alias yet. */
  | { status: 'not-ready' }
  | { status: 'ready'; tiers: ReadonlySet<ModelTier> }

export type ModelTierCardState =
  | { kind: 'available' }
  | { kind: 'coming-soon' }
  | { kind: 'locked'; plan: 'advanced' | 'fast' }
  /** Waiting for the entitled list; not yet a reason to show a lock. */
  | { kind: 'pending' }
  /** No usable answer (unknown / not-ready): only Flash runs meanwhile. */
  | { kind: 'unavailable' }

export function modelTierAvailabilityFromProviders(
  providers: readonly ModelOptionProvider[] | null | undefined
): ModelTierAvailability {
  const managed = (providers ?? []).find(provider => isManagedProviderSlug(provider.slug, provider.name))

  if (!managed) {
    return { status: 'unknown' }
  }

  const tiers = availableModelTiers(managed.models)

  return tiers.size > 0 ? { status: 'ready', tiers } : { status: 'not-ready' }
}

/**
 * The state of one tier card. Flash is always selectable: it is the default
 * every plan carries and the tier the relay falls back to. Max reads 即将开放
 * until the platform opens it (Kael 2026-10-19: after the cost factor is
 * enforced and legal confirms), whatever the plan.
 */
export function modelTierCardState(
  tier: ModelTier,
  availability: ModelTierAvailability,
  maxOpen: boolean
): ModelTierCardState {
  if (tier === 'max' && !maxOpen) {
    return { kind: 'coming-soon' }
  }

  if (tier === DEFAULT_MODEL_TIER) {
    return { kind: 'available' }
  }

  if (availability.status === 'loading') {
    return { kind: 'pending' }
  }

  if (availability.status !== 'ready') {
    return { kind: 'unavailable' }
  }

  if (availability.tiers.has(tier)) {
    return { kind: 'available' }
  }

  const plan = MODEL_TIER_UNLOCK_PLAN[tier]

  return plan ? { kind: 'locked', plan } : { kind: 'unavailable' }
}

export const MODEL_TIER_AVAILABILITY_QUERY_KEY = ['model-tier-availability'] as const

/** The account's tiers, read from the active profile's model inventory. The
 *  relay key — and so the plan's entitlements — is the account's, so every
 *  assistant shares one answer. */
export function useModelTierAvailability(enabled = true): ModelTierAvailability {
  const query = useQuery({
    queryKey: MODEL_TIER_AVAILABILITY_QUERY_KEY,
    queryFn: async () => modelTierAvailabilityFromProviders((await getGlobalModelOptions()).providers),
    enabled,
    retry: 1,
    staleTime: 60_000
  })

  if (query.data) {
    return query.data
  }

  return query.isError ? { status: 'unknown' } : { status: 'loading' }
}
