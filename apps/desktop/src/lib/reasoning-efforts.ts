import { modelVendor, type VendorKey } from '@/lib/model-vendor'

// Which reasoning-effort levels to offer for a given model.
//
// WHY THIS EXISTS (hc-598)
// -----------------------
// Hermes' effort vocabulary has seven levels (hermes_constants.py
// `VALID_REASONING_EFFORTS`), and the submenu used to render all seven for
// every model. Vendors publish two to four. The extra rows are not "more
// control" — they are choices the backend either silently folds into a level
// the user could already pick, or rejects.
//
// WHERE THE LEVELS COME FROM
// --------------------------
// Nothing per-model reaches this renderer today. `model.options` carries
// `capabilities[model]` = `{fast, reasoning}` — reasoning is a BOOLEAN
// (hermes_cli/inventory.py `_apply_capabilities`, sourced from models.dev,
// which itself only publishes `reasoning: bool`). The runtime's only two
// per-model level lists are unreachable from here:
//
//   - `github_model_reasoning_efforts` (hermes_cli/models.py) — GitHub Copilot
//     catalog only, and Copilot is both hidden from this picker and in the
//     desktop's `MODEL_DISABLED_PROVIDERS`;
//   - LM Studio's live `capabilities.reasoning.allowed_options` probe
//     (agent/lmstudio_reasoning.py) — local provider, hidden here, and never
//     serialized into the model-options payload.
//
// So the honest per-model signal available in the renderer is the VENDOR
// behind the model id — which the picker already resolves for brand icons
// (`modelVendor`) — matched against what the runtime's own provider profiles
// do with each effort on the wire. Those profiles are the evidence for every
// entry in the table below; each carries its file.
//
// This matters most for the managed relay, which is registered as the generic
// `custom` provider: its profile (plugins/model-providers/custom/__init__.py)
// forwards our effort string top-level, VERBATIM, to whatever vendor the relay
// routes to. There is no clamp in between, so an invented level travels all
// the way to the vendor's API.
//
// UPGRADE PATH
// ------------
// When the runtime grows a per-model level list — `_apply_capabilities`
// emitting `capabilities[model].reasoning_efforts`, the shape LM Studio and
// the Copilot catalog already have internally — prefer it over this table:
// take `caps.reasoning_efforts` when present and fall through to
// `supportedReasoningEfforts` when absent. The table then only covers models
// the catalog does not describe.

/** The runtime's full effort vocabulary, weakest → strongest.
 *  Mirrors hermes_constants.py `VALID_REASONING_EFFORTS`; `none` is not here —
 *  it is owned by the Thinking toggle, not the effort radio. */
export const REASONING_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type ReasoningEffort = (typeof REASONING_EFFORT_LADDER)[number]

/** What to offer when the model's vendor is unknown (a BYOK endpoint serving
 *  `my-tuned-model`, a vendor we have no profile evidence for). Deliberately
 *  conservative: low/medium/high is the set every OpenAI-compatible reasoning
 *  API in the tree accepts, and the one Hermes' own provider profiles pass
 *  through unmapped. Guessing wider risks a 400 the user cannot explain. */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/** Per-vendor levels, each one grounded in the runtime provider profile that
 *  translates our effort onto that vendor's wire format. Entries are evidence,
 *  not preference — add one only with a file to point at. */
const VENDOR_REASONING_EFFORTS: Partial<Record<VendorKey, readonly ReasoningEffort[]>> = {
  // plugins/model-providers/deepseek/__init__.py: low/medium/high pass through
  // as-is; xhigh/max/ultra all collapse onto DeepSeek's `max`. Four distinct
  // levels, seven names for them.
  deepseek: ['low', 'medium', 'high', 'max'],
  // plugins/model-providers/kimi-coding/__init__.py: only low/medium/high are
  // sent as `reasoning_effort`; anything else falls back to the thinking flag
  // (Moonshot rejects thinking + reasoning_effort together).
  kimi: ['low', 'medium', 'high'],
  // plugins/model-providers/zai/__init__.py `_glm_5_2_reasoning_effort`:
  // "GLM-5.2 only supports two enabled effort levels" — high is its MINIMUM
  // thinking level, and xhigh/max/ultra all request max.
  zhipu: ['high', 'max']
}

const LADDER_INDEX = new Map<string, number>(REASONING_EFFORT_LADDER.map((effort, index) => [effort, index]))

/** The effort levels worth showing for a model, weakest → strongest.
 *  `providerHint` is the provider row's name/slug, used only when the model id
 *  itself is anonymous (same fallback `modelVendor` uses for its icons). */
export function supportedReasoningEfforts(model: string, providerHint?: string): readonly ReasoningEffort[] {
  const vendor = modelVendor(model, providerHint)

  return (vendor && VENDOR_REASONING_EFFORTS[vendor]) || DEFAULT_REASONING_EFFORTS
}

/** Map a saved effort onto the closest level a model actually offers.
 *
 *  A preference is never dropped or rejected — `ultra` on a model that tops
 *  out at `high` becomes `high`, `minimal` on GLM (whose floor is `high`)
 *  becomes `high`. Distance is measured on the shared ladder, and a tie
 *  resolves upward so a request for more thinking never quietly returns less.
 *  An unrecognized value falls back to Hermes' own default (`medium`). */
export function nearestSupportedEffort(effort: string, supported: readonly ReasoningEffort[]): ReasoningEffort {
  const levels = supported.length > 0 ? supported : DEFAULT_REASONING_EFFORTS
  const normalized = effort.trim().toLowerCase()

  if (levels.includes(normalized as ReasoningEffort)) {
    return normalized as ReasoningEffort
  }

  const target = LADDER_INDEX.get(normalized) ?? LADDER_INDEX.get('medium')!

  return levels.reduce((best, candidate) => {
    const bestDistance = Math.abs((LADDER_INDEX.get(best) ?? 0) - target)
    const candidateDistance = Math.abs((LADDER_INDEX.get(candidate) ?? 0) - target)

    // `<=` keeps the later (stronger, since the table is ladder-ordered)
    // candidate on a tie.
    return candidateDistance <= bestDistance ? candidate : best
  }, levels[0])
}

/** Resolve the value a user-facing model row/pill should display. Saved values
 *  can outlive a model switch or an older seven-rung menu; show the level this
 *  model will actually honor, while preserving the explicit thinking-off
 *  state. */
export function displayedReasoningEffort(
  effort: string,
  model: string,
  providerHint?: string,
  fallback = 'medium'
): 'none' | ReasoningEffort {
  const normalized = effort.trim().toLowerCase() || fallback

  return normalized === 'none'
    ? 'none'
    : nearestSupportedEffort(normalized, supportedReasoningEfforts(model, providerHint))
}
