/**
 * APEX model tiers — Flash / Pro / Max (hc-960).
 *
 * An APEX account never picks a model. Each assistant (a Hermes profile) runs
 * on one of three tiers, and the relay maps the tier alias to whatever platform
 * model backs it today (its catalog `upstream_model`). The desktop only writes
 * and reads the alias. Which tiers an account may use is the relay's entitled
 * model list (`GET /v1/models`, surfaced as the managed provider's `models`),
 * never a plan check here.
 *
 * Pure helpers only: the switch that turns tier mode on lives in
 * `store/model-tiers.ts`, the electron twin of the aliases in
 * `electron/apex-managed.ts` (MODEL_TIER_ALIASES).
 */

import { APEX_PUBLIC_LLM_MODELS, isManagedProviderSlug, MANAGED_PROVIDER_SLUG } from '@/lib/provider-allowlist'

export const MODEL_TIERS = ['flash', 'pro', 'max'] as const

export type ModelTier = (typeof MODEL_TIERS)[number]

/** Kael 2026-10-19: every assistant starts on Flash. */
export const DEFAULT_MODEL_TIER: ModelTier = 'flash'

/** The relay alias each tier is written as. Lowercase, no `-APEX` suffix: the
 *  relay matches `body.model` against its allowed list verbatim. */
export const MODEL_TIER_ALIAS: Readonly<Record<ModelTier, string>> = {
  flash: 'apex-flash',
  pro: 'apex-pro',
  max: 'apex-max'
}

/** Tier names are product names, the same in every locale. */
export const MODEL_TIER_LABEL: Readonly<Record<ModelTier, string>> = {
  flash: 'Flash',
  pro: 'Pro',
  max: 'Max'
}

/** Which plan first unlocks a tier — copy only ("快速版起可用"). Whether THIS
 *  account has it is answered by the relay's entitled list, not by this map. */
export const MODEL_TIER_UNLOCK_PLAN: Readonly<Record<ModelTier, 'advanced' | 'fast' | null>> = {
  flash: null,
  pro: 'fast',
  max: 'advanced'
}

const TIER_BY_ALIAS = new Map(MODEL_TIERS.map(tier => [MODEL_TIER_ALIAS[tier], tier]))

const LEGACY_MANAGED_MODELS: ReadonlySet<string> = new Set(APEX_PUBLIC_LLM_MODELS)

function bareModelId(model: string | null | undefined): string {
  const trimmed = String(model || '').trim()
  const slash = trimmed.lastIndexOf('/')

  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase()
}

/** The tier an id names, or null when it is not a tier alias. */
export function modelTierForAlias(model: string | null | undefined): ModelTier | null {
  return TIER_BY_ALIAS.get(bareModelId(model)) ?? null
}

export function isModelTierAlias(model: string | null | undefined): boolean {
  return modelTierForAlias(model) !== null
}

/** The next stronger tier, or null on Max. */
export function nextModelTier(tier: ModelTier): ModelTier | null {
  const index = MODEL_TIERS.indexOf(tier)

  return index >= 0 && index < MODEL_TIERS.length - 1 ? MODEL_TIERS[index + 1] : null
}

/** Tiers whose alias the relay listed for this account. */
export function availableModelTiers(models: readonly string[] | null | undefined): Set<ModelTier> {
  const available = new Set<ModelTier>()

  for (const model of models ?? []) {
    const tier = modelTierForAlias(model)

    if (tier) {
      available.add(tier)
    }
  }

  return available
}

/** A managed-relay id from before tiers: the `-APEX` seed sentinel or one of
 *  the old first-party shelf ids. */
function isLegacyManagedModel(model: string): boolean {
  const bare = bareModelId(model)

  return /-apex$/.test(bare) || LEGACY_MANAGED_MODELS.has(bare)
}

export type AssistantModelChoice =
  /** Runs on the APEX relay. `legacy` = an id from before tiers, shown and
   *  routed as the default tier (the relay falls back to it for unknown ids). */
  | { kind: 'tier'; legacy: boolean; tier: ModelTier }
  /** The user's own provider or endpoint, configured under 高级. */
  | { kind: 'own' }

/** What an assistant's configured main model means in tier terms. */
export function assistantModelChoice(
  model: string | null | undefined,
  provider: string | null | undefined
): AssistantModelChoice {
  const tier = modelTierForAlias(model)

  if (tier) {
    return { kind: 'tier', legacy: false, tier }
  }

  const id = String(model || '').trim()

  const slug = String(provider || '')
    .trim()
    .toLowerCase()

  if (!id) {
    return { kind: 'tier', legacy: false, tier: DEFAULT_MODEL_TIER }
  }

  if (isManagedProviderSlug(slug)) {
    return { kind: 'tier', legacy: true, tier: DEFAULT_MODEL_TIER }
  }

  if ((slug === '' || slug === 'custom') && isLegacyManagedModel(id)) {
    return { kind: 'tier', legacy: true, tier: DEFAULT_MODEL_TIER }
  }

  return { kind: 'own' }
}

/** The tier label a model id is shown as in tier mode, or '' when it should
 *  not be shown at all (the user's own model on a surface that only speaks
 *  tiers). */
export function modelTierDisplayName(model: string | null | undefined, provider?: string | null): string {
  const choice = assistantModelChoice(model, provider)

  return choice.kind === 'tier' ? MODEL_TIER_LABEL[choice.tier] : ''
}

export interface ModelNameMaskCopy {
  /** Replacement for the `Model:` line label in backend text (e.g. 档位). */
  lineLabel: string
  /** Shown for a model that is not on a tier (the user's own service). */
  ownModel: string
}

// `-APEX` ids, bare tier aliases and the legacy first-party shelf. Matched as
// whole tokens: an id is a run of [\w.:/-] that is neither preceded nor
// followed by another id character.
const MODEL_TOKEN_SOURCE = [
  '[\\w.:/-]*-APEX',
  ...MODEL_TIERS.map(tier => MODEL_TIER_ALIAS[tier]),
  ...APEX_PUBLIC_LLM_MODELS.map(model => model.replace(/[.]/g, '\\.'))
].join('|')

/**
 * Rewrite backend text (slash output such as `/status`) so it never names a
 * model in tier mode: the `Model: <id> (<provider>)` line becomes
 * `<lineLabel>: <Tier>`, and any APEX model id left in the text is replaced by
 * its tier label.
 */
export function maskModelNamesInText(text: string, copy: ModelNameMaskCopy): string {
  const withLine = text.replace(
    /^([ \t]*)Model:[ \t]*(\S+)(?:[ \t]+\(([^)\n]*)\))?[ \t]*$/gm,
    (_match, indent, id, provider) => {
      const label = modelTierDisplayName(id, provider) || copy.ownModel

      return `${indent}${copy.lineLabel}: ${label}`
    }
  )

  return withLine.replace(new RegExp(`(?<![\\w.:/-])(?:${MODEL_TOKEN_SOURCE})(?![\\w.:/-])`, 'gi'), token => {
    return modelTierDisplayName(token, 'custom') || token
  })
}

// ── "换更强的再答一次" ───────────────────────────────────────────────────────
// The button under an answer re-runs that turn one tier up. The tier rides
// assistant-ui's reload run config, so the regenerate path that already exists
// (primary chat and side tiles alike) carries it instead of a second one.

const RETRY_TIER_KEY = 'apexTier'

/** The `reload()` config that asks for a stronger tier. */
export function retryTierReloadConfig(tier: ModelTier): { runConfig: { custom: Record<string, ModelTier> } } {
  return { runConfig: { custom: { [RETRY_TIER_KEY]: tier } } }
}

/** The tier a reload asked for, or null for a plain regenerate. */
export function retryTierFromReloadConfig(config: unknown): ModelTier | null {
  const custom = (config as { runConfig?: { custom?: Record<string, unknown> } } | null | undefined)?.runConfig?.custom
  const value = custom?.[RETRY_TIER_KEY]

  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value) ? (value as ModelTier) : null
}

type GatewayRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/**
 * Move ONE session to a tier (`--session`): the retry and the rest of that chat
 * run on it, while the assistant's own tier in its settings stays put.
 * A guarded switch (`confirm_required`) is not applied here — it throws, so the
 * caller reports it instead of regenerating on the old tier.
 */
export async function switchSessionToModelTier(
  request: GatewayRequest,
  sessionId: string,
  tier: ModelTier
): Promise<{ model: string; provider: string }> {
  const model = MODEL_TIER_ALIAS[tier]
  const provider = MANAGED_PROVIDER_SLUG

  const result = await request<{
    confirm_message?: string
    confirm_required?: boolean
    model?: string
    provider?: string
  }>('config.set', { key: 'model', session_id: sessionId, value: `${model} --provider ${provider} --session` })

  if (result?.confirm_required) {
    throw new Error(result.confirm_message || `${MODEL_TIER_LABEL[tier]} needs confirmation`)
  }

  return { model: result?.model || model, provider: result?.provider || provider }
}
