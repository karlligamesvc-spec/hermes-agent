import { modelBaseId } from '@/lib/model-status-label'
import type { MoaConfigResponse, MoaModelSlot } from '@/types/hermes'

// Silent multi-model composition (hc-578, MOA-INVISIBLE-DESIGN-2026-07-18).
//
// When the user selects 2+ platform models the picker composes them into a
// hidden Mixture-of-Agents preset — the user never sees "MoA", "aggregator" or
// "reference". This module holds the pure composition rules so they are
// table-testable in isolation from React.

/** Reserved preset name for the silently-synthesized multi-model config. Never
 *  shown to the user (the picker renders "N models selected", not a preset). */
export const AUTO_PRESET_NAME = '__auto__'

/**
 * Whether upstream's EXPLICIT Mixture-of-Agents UI may render.
 *
 * Upstream ships two such surfaces — Settings › 模型's preset/aggregator/
 * reference editor, and the composer model menu's "MoA presets" list — both of
 * which name the mechanism this design exists to hide. ApexNodes keeps them
 * shut and offers the silent multi-select instead.
 *
 * Held as a flag rather than deleting upstream's markup so the next version
 * bump merges without conflicting on those blocks. Typed `boolean` (not the
 * `false` literal) so the gated JSX stays type-checked rather than narrowed
 * away.
 */
export const SHOW_EXPLICIT_MOA_UI: boolean = false

/** Slug of the catalog's VIRTUAL Mixture-of-Agents provider row. The runtime
 *  synthesizes it from `config["moa"].presets` (hermes_cli/inventory.py
 *  `_moa_provider_row`) and every `model.options` payload carries it, so each
 *  surface that renders the catalog has to decide about it explicitly. Its
 *  "models" are preset NAMES — including the reserved `__auto__` the silent
 *  multi-select writes — so listing the row leaks both the mechanism and the
 *  preset vocabulary. */
export const MOA_PROVIDER_SLUG = 'moa'

/** True when a catalog provider row is that virtual MoA row. */
export const isMoaProviderSlug = (slug: string | null | undefined): boolean =>
  String(slug || '')
    .trim()
    .toLowerCase() === MOA_PROVIDER_SLUG

/** Header for one selected model's advisory block in the reasoning disclosure.
 *
 *  A composed multi-model turn streams each advisor's answer ahead of the
 *  acting model's reply (runtime event `moa.reference`), and upstream labels
 *  those blocks "Reference i/n — <slot>" — the exact 参考模型 vocabulary
 *  MOA-INVISIBLE-DESIGN §UI bans from every user surface. The user picked these
 *  models by name, so the neutral form keeps the transparency (which model
 *  spoke, and where it sits in the run) and drops only the mechanism word.
 *  Upstream's wording stays reachable behind {@link SHOW_EXPLICIT_MOA_UI}. */
export function advisoryBlockHeader(label: string, index?: number, count?: number): string {
  const position = index && count ? `${index}/${count}` : ''

  if (SHOW_EXPLICIT_MOA_UI) {
    const name = label || 'reference'

    return position ? `◇ Reference ${position} — ${name}` : `◇ Reference — ${name}`
  }

  if (!label) {
    return position ? `◇ ${position}` : '◇'
  }

  return position ? `◇ ${label} · ${position}` : `◇ ${label}`
}

/** Aggregator priority — best quality-per-cost first (MOA-INVISIBLE-DESIGN §3).
 *  The aggregator is the ACTING model (holds the tools, takes every turn), so
 *  its discipline/speed/cost dominate; the strongest-cheapest domestic model
 *  leads. A selected model NOT in this list ranks last — it becomes the
 *  aggregator only when nothing ranked was selected, and ties there fall to the
 *  earliest in directory (picker) order. The aggregator MUST come from the
 *  selected set, else the ledger would surface a model the user never picked
 *  (§3). Compared on the bare routed id (provider prefix + managed `-APEX` brand
 *  suffix stripped). */
export const AGGREGATOR_RANKING: readonly string[] = ['qwen3.7-max', 'deepseek-v4-pro', 'kimi-k2.6', 'glm-5.2']

const APEX_SUFFIX = /-apex$/i

/** Bare routed model id — used both for aggregator ranking and as the slot the
 *  relay routes on. The managed default surfaces in the picker as the display id
 *  `deepseek-v4-pro-APEX`; the relay routes the bare `deepseek-v4-pro` (hc-184),
 *  which is also the form the curated seed preset uses. */
export function routedModelId(model: string): string {
  return modelBaseId(String(model || '')).replace(APEX_SUFFIX, '')
}

function rankOf(model: string): number {
  const index = AGGREGATOR_RANKING.indexOf(routedModelId(model).toLowerCase())

  return index === -1 ? Number.POSITIVE_INFINITY : index
}

const slotKey = (slot: MoaModelSlot): string => `${slot.provider} ${routedModelId(slot.model)}`

/** Case-insensitive, provider-agnostic routed-id key — matches a picker row's
 *  model id against a saved preset's member id regardless of casing (e.g. a
 *  directory `GLM-5.2` vs a persisted `glm-5.2`). Shared by every surface that
 *  reconstructs "what's currently selected" from a live MoA preset (settings
 *  page, composer picker) so the two can never diverge. */
export const routedKey = (model: string): string => routedModelId(model).toLowerCase()

/** Pick the aggregator: the highest-ranked model in the selected set. Ties (all
 *  unranked) fall to the first by directory order, so `selected` MUST already be
 *  in directory order. Returns null for an empty set. */
export function pickAggregator(selected: readonly MoaModelSlot[]): MoaModelSlot | null {
  let best: MoaModelSlot | null = null
  let bestRank = Number.POSITIVE_INFINITY

  for (const slot of selected) {
    const rank = rankOf(slot.model)

    // Strict `<` keeps the earliest directory-order model on a tie (all the same
    // rank, e.g. every selection unranked → first wins).
    if (best === null || rank < bestRank) {
      best = slot
      bestRank = rank
    }
  }

  return best
}

export interface ComposedMoa {
  aggregator: MoaModelSlot
  reference_models: MoaModelSlot[]
  fanout: 'user_turn'
}

/** Compose the hidden MoA plan from a selected set S (in directory order):
 *  aggregator A = ranked pick, references = S \ {A} (plan 甲, MOA-INVISIBLE §3 /
 *  §9: each selected model runs exactly once). Slot ids are normalized to the
 *  bare routed id the relay routes on, and the set is de-duplicated by
 *  provider+routed-id. Returns null when the de-duplicated set has <= 1 member —
 *  the caller keeps the plain single-model path (no MoA).
 *
 *  `fanout` is PINNED to "user_turn": the default "per_iteration" re-runs the
 *  reference fan-out on every tool step, so an agentic turn costs (N)×K instead
 *  of ~N. That is the billing red line (MOA-INVISIBLE §2.2 / §7) — the advisors
 *  give their plan-level advice once per user turn, then the aggregator acts
 *  alone through the tool loop. */
export function composeAutoMoa(selected: readonly MoaModelSlot[]): ComposedMoa | null {
  const seen = new Set<string>()
  const set: MoaModelSlot[] = []

  for (const slot of selected) {
    const normalized: MoaModelSlot = { provider: slot.provider, model: routedModelId(slot.model) }
    const key = slotKey(normalized)

    if (!seen.has(key)) {
      seen.add(key)
      set.push(normalized)
    }
  }

  if (set.length <= 1) {
    return null
  }

  const aggregator = pickAggregator(set) as MoaModelSlot
  const aggregatorKey = slotKey(aggregator)
  const reference_models = set.filter(slot => slotKey(slot) !== aggregatorKey)

  return { aggregator, reference_models, fanout: 'user_turn' }
}

// Reference/aggregator temperatures mirror the curated managed seed
// (electron/main.cjs SEED_MOA_BLOCK): references diverge (0.6) for panel
// diversity, the acting aggregator stays tight (0.4).
const AUTO_REFERENCE_TEMPERATURE = 0.6
const AUTO_AGGREGATOR_TEMPERATURE = 0.4
const AUTO_MAX_TOKENS = 4096

/** Build the full MoA config to persist for a composed multi-model selection.
 *  Merges the `__auto__` preset into any existing presets (existing/seed presets
 *  are preserved but left inactive) and pins it as both default and active so
 *  `set_model_assignment{provider:moa, model:__auto__}` activates exactly it. The
 *  flattened compatibility fields mirror the active preset; the backend
 *  re-normalizes from `presets` regardless. */
export function buildAutoMoaConfig(existing: MoaConfigResponse | null, composed: ComposedMoa): MoaConfigResponse {
  const degradedReferencePolicy = existing?.degraded_reference_policy ?? 'loud'
  const referenceTimeout = existing?.reference_timeout ?? null

  const preset = {
    reference_models: composed.reference_models,
    aggregator: composed.aggregator,
    reference_temperature: AUTO_REFERENCE_TEMPERATURE,
    aggregator_temperature: AUTO_AGGREGATOR_TEMPERATURE,
    enabled: true,
    max_tokens: AUTO_MAX_TOKENS,
    fanout: composed.fanout,
    degraded_reference_policy: degradedReferencePolicy,
    reference_timeout: referenceTimeout
  }

  return {
    default_preset: AUTO_PRESET_NAME,
    active_preset: AUTO_PRESET_NAME,
    presets: { ...(existing?.presets ?? {}), [AUTO_PRESET_NAME]: preset },
    reference_models: composed.reference_models,
    aggregator: composed.aggregator,
    reference_temperature: AUTO_REFERENCE_TEMPERATURE,
    aggregator_temperature: AUTO_AGGREGATOR_TEMPERATURE,
    enabled: true,
    max_tokens: AUTO_MAX_TOKENS,
    fanout: composed.fanout,
    degraded_reference_policy: degradedReferencePolicy,
    reference_timeout: referenceTimeout
  }
}

type MoaPreset = MoaConfigResponse['presets'][string]

/** Member count of a saved preset (aggregator + its references) — the only
 *  number any surface is allowed to show ("N models selected"); the
 *  aggregator/reference split underneath stays invisible everywhere
 *  (MOA-INVISIBLE-DESIGN). */
export function composedMemberCount(preset: MoaPreset | null | undefined): number {
  if (!preset) {
    return 0
  }

  return preset.reference_models.length + 1
}

/** Expand an active `provider === 'moa'` preset back to its member model ids,
 *  in the given directory order — the inverse of {@link composeAutoMoa}.
 *  Shared by every surface that must reconstruct "which models are currently
 *  selected" from a live preset (settings page, composer picker); returns an
 *  empty array when the preset key isn't found (stale/missing config). */
export function expandMoaPresetMembers(
  moa: MoaConfigResponse | null | undefined,
  presetKey: string,
  directoryModels: readonly string[]
): string[] {
  const preset = moa?.presets?.[presetKey]

  if (!preset) {
    return []
  }

  const wanted = new Set<string>([...preset.reference_models, preset.aggregator].map(slot => routedKey(slot.model)))

  return directoryModels.filter(raw => wanted.has(routedKey(raw)))
}
