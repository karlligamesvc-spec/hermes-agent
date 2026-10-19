import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useCallback } from 'react'

import { displayModelName } from '@/lib/model-status-label'
import { modelTierDisplayName } from '@/lib/model-tiers'
import { $authState, type DesktopAuthState } from '@/store/auth'
import { $freeTierStatus } from '@/store/free-tier'

/**
 * Tier mode (hc-960): an APEX account sees Flash / Pro / Max instead of any
 * model picker or model name.
 *
 * On only when BOTH hold:
 *  - the shell's tier switch is on (`managed.status().modelTiers`, default off
 *    until the relay serves the `apex-*` aliases — electron/apex-managed.ts);
 *  - this window runs on an APEX account (managed path enabled and signed in,
 *    or the soft `expired` degrade that still belongs to that account).
 *
 * A BYOK user ("使用自己的密钥", `enabled: false`) and a managed-disabled build
 * keep the full model UI.
 */
export function isModelTierMode(state: Pick<DesktopAuthState, 'enabled' | 'modelTiers' | 'status'>): boolean {
  return (
    state.modelTiers === true && state.enabled === true && (state.status === 'signed-in' || state.status === 'expired')
  )
}

export const $modelTierMode = computed($authState, isModelTierMode)

/** Max opens later than the other two (Kael 2026-10-19: after the quota cost
 *  factor is enforced and legal signs off). Until the shell reports the Max
 *  switch, the Max card says 即将开放 for everyone. */
export const $modelTierMaxOpen = computed($authState, state => isModelTierMode(state) && state.modelTierMax === true)

/** The Nous free tier (its sign-in, its model id) is not an APEX concept: in
 *  tier mode its status reads as absent wherever it is painted — the status-bar
 *  chip and the composer strip both subscribe to this instead of the raw atom. */
export const $freeTierStatusForChrome = computed([$freeTierStatus, $modelTierMode], (status, tierMode) =>
  tierMode ? null : status
)

/** Keybind actions that only open a model picker; inert and unlisted in tier
 *  mode (the shortcuts panel and Settings › 快捷键 both filter on this). */
export const MODEL_TIER_HIDDEN_KEYBIND_ACTIONS: ReadonlySet<string> = new Set(['composer.modelPicker'])

/** Slash commands that pick or compose models (`/model <id>` runs on the
 *  backend and would switch the session's model). In tier mode they answer
 *  with where the tier lives instead, and stay out of the slash popover. */
export const MODEL_TIER_BLOCKED_SLASH_COMMANDS: ReadonlySet<string> = new Set(['/model', '/moa'])

export function useModelTierMode(): boolean {
  return useStore($modelTierMode)
}

export function useModelTierMaxOpen(): boolean {
  return useStore($modelTierMaxOpen)
}

/**
 * The name a surface shows for a model id: in tier mode its tier (Flash / Pro /
 * Max), or '' — show nothing — for the user's own model; otherwise the friendly
 * model name. Every display-only surface (session cards, subagent rows, profile
 * cards…) goes through this, so tier mode cannot leak a model name there.
 */
export function userFacingModelName(model: string, provider?: null | string): string {
  return $modelTierMode.get() ? modelTierDisplayName(model, provider) : displayModelName(model)
}

/** `userFacingModelName` for components: re-renders when tier mode flips. */
export function useUserFacingModelName(): (model: string, provider?: null | string) => string {
  const tierMode = useModelTierMode()

  return useCallback(
    (model: string, provider?: null | string) =>
      tierMode ? modelTierDisplayName(model, provider) : displayModelName(model),
    [tierMode]
  )
}
