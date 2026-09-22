import { reasoningEffortLabel } from '@/lib/reasoning-effort'

// Backward-compatible SDK export; there is one implementation and one seven-
// rung vocabulary now. User-facing callers pass their localized compact map.
export { reasoningEffortLabel } from '@/lib/reasoning-effort'

/** Which model/provider pair a picker should mark "current". SessionView state
 *  also drives the composer label, so a complete pair there wins over an older
 *  `model.options` response. During initial hydration, options remain the
 *  fallback. Pick one complete pair before mixing fields so a model is never
 *  shown under a different provider. */
export function currentPickerSelection(
  _hasSession: boolean,
  store: { model: string; provider: string },
  options?: { model?: string; provider?: string }
): { model: string; provider: string } {
  const storeSelection = {
    model: String(store.model || ''),
    provider: String(store.provider || '')
  }

  const optionsSelection = {
    model: String(options?.model || ''),
    provider: String(options?.provider || '')
  }

  if (storeSelection.model && storeSelection.provider) {
    return storeSelection
  }

  if (optionsSelection.model && optionsSelection.provider) {
    return optionsSelection
  }

  return {
    model: storeSelection.model || optionsSelection.model,
    provider: storeSelection.provider || optionsSelection.provider
  }
}

/** Strip provider prefix and normalize for display. */
export function modelBaseId(model: string): string {
  const trimmed = model.trim()
  const slash = trimmed.lastIndexOf('/')

  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

// Trailing model-id variants that should render as a grayed tag beside the
// name (e.g. "Opus 4.8" + "Fast") rather than collapsing two distinct ids to
// the same display name.
const VARIANT_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-fast$/i, 'Fast'],
  [/-thinking$/i, 'Thinking'],
  [/-preview$/i, 'Preview'],
  [/-latest$/i, 'Latest']
]

const titleCase = (text: string): string => text.replace(/\b\w/g, char => char.toUpperCase()).trim()

// Brand names whose official casing plain title-casing gets wrong
// ("glm-5.2" → "Glm 5.2", "deepseek-…" → "Deepseek …"). Applied word-wise
// after titleCase.
const ACRONYM_WORDS: Record<string, string> = {
  Deepseek: 'DeepSeek',
  Glm: 'GLM',
  Mimo: 'MiMo'
}

const fixAcronyms = (text: string): string => text.replace(/\b[A-Z][a-z]+\b/g, word => ACRONYM_WORDS[word] ?? word)

function prettifyBase(base: string): string {
  if (/^claude-/i.test(base)) {
    return titleCase(base.replace(/^claude-/i, '').replace(/-/g, ' '))
  }

  if (/^gpt-/i.test(base)) {
    return base.replace(/^gpt-/i, 'GPT-')
  }

  if (/^gemini-/i.test(base)) {
    return base.replace(/^gemini-/i, 'Gemini ').replace(/-/g, ' ')
  }

  // Ark-style ids encode semantic version segments with hyphens (id syntax
  // forbids dots): `doubao-seed-2-1-pro` means "Seed 2.1", not "Seed 2 1".
  // Restore a hyphen between two digits to a dot before the generic
  // hyphen→space split, so consecutive segments chain correctly
  // (`1-2-3` → `1.2.3`) via the lookahead re-using the un-consumed digit as
  // the next match's start.
  const dotted = base.replace(/(\d)-(?=\d)/g, '$1.')

  return fixAcronyms(titleCase(dotted.replace(/-/g, ' ')))
}

// The ApexNodes managed-relay sentinel suffix (see electron/apex-managed.ts
// MANAGED_MODEL_DISPLAY): the config anchor id carries `-APEX` so it can't
// collide with a built-in provider catalog. For DISPLAY it is a brand marker,
// not part of the model name — every surface (composer pill, picker rows,
// visibility dialog) derives from this one splitter, so the same id can never
// render under two different names again (hc-512).
const APEX_SENTINEL_SUFFIX = /-APEX$/i

/** Split a model id into a clean display name plus an optional grayed variant
 *  tag, so distinct ids (e.g. `…-4.8` vs `…-4.8-fast`) don't collapse. */
export function modelDisplayParts(model: string): { name: string; tag: string } {
  let base = modelBaseId(model)
  const tags: string[] = []

  // Managed-relay sentinel: strip the brand suffix into the tag slot so the
  // NAME matches the bare routed id's name exactly (one display everywhere).
  if (APEX_SENTINEL_SUFFIX.test(base)) {
    tags.push('APEX')
    base = base.replace(APEX_SENTINEL_SUFFIX, '')
  }

  // Local GGUF ids carry a quant suffix (`…-UD-Q4_K_XL`, `…-Q8_0`). Render it
  // as a quiet tag instead of leaking the raw quant string into the model name.
  const quant = base.match(/-(?:UD-)?(Q\d(?:_[A-Z0-9]+)*|IQ\d(?:_[A-Z0-9]+)*|F16|BF16)$/i)

  if (quant) {
    tags.unshift(quant[1].split('_')[0].toUpperCase())
    base = base.slice(0, -quant[0].length)
    base = base.replace(/-(?:Instruct|Chat)(?:-\d{4})?$/i, '')
  } else {
    for (const [pattern, label] of VARIANT_TAGS) {
      if (pattern.test(base)) {
        tags.unshift(label)
        base = base.replace(pattern, '')

        break
      }
    }
  }

  // Drop a trailing date-pin — snapshot noise, not a name. Ark ids use a
  // 6-digit YYMMDD pin (`doubao-seed-2-1-pro-260628`); other providers use
  // an 8-digit YYYYMMDD pin (`claude-opus-4-5-20251101`). The optional
  // trailing pair greedily extends a 6-digit match to 8 when present, so
  // both widths are stripped by one pattern.
  base = base.replace(/-\d{6}(\d{2})?$/, '')

  return { name: prettifyBase(base) || model.trim() || 'No model', tag: tags.join(' ') }
}

// ApexNodes managed-LLM display mapping. The managed default seeds
// `model.default: deepseek-v4-pro` routed through the relay; the UI shows the
// ApexNodes-branded label. The relay decouples display from routing (hc-184),
// so this is purely cosmetic. Kept in sync with electron/apex-managed.ts
// (DEFAULT_MANAGED_MODEL / MANAGED_MODEL_DISPLAY).
const MANAGED_MODEL_ID = 'deepseek-v4-pro'
const MANAGED_MODEL_DISPLAY = 'deepseek-v4-pro-APEX'

/** Map the managed relay model id to its ApexNodes display label; pass other
 *  ids through unchanged. Applied at the visible "current model" chokepoints so
 *  a managed user sees the branded name instead of the raw routed id. */
export function managedModelDisplayName(model: string): string {
  return modelBaseId(model) === MANAGED_MODEL_ID ? MANAGED_MODEL_DISPLAY : model
}

/** Friendly one-line model name for menus and the status bar. */
export function displayModelName(model: string): string {
  return modelDisplayParts(model).name
}

/** Composer model label. Reasoning has its own control beside the model pill,
 *  so duplicating it here wastes the width needed by long model names. */
export function formatModelPillLabel(model: string, options?: { fastMode?: boolean }): string {
  const name = displayModelName(model)

  if (model.trim() && (options?.fastMode || /-fast$/i.test(modelBaseId(model)))) {
    return `${name} · Fast`
  }

  return name
}

/** Status bar trigger label — model name plus the live session state (effort/fast).
 *  `displayModelName` already folds the managed `-APEX` brand suffix into the tag
 *  slot (modelDisplayParts), so the pill and the picker rows render the exact
 *  same name — no surface-local stripping needed here (hc-512).
 *
 *  `effortLabel`/`fastLabel` let the caller pass localized display text (the
 *  composer pill passes the zh 低/中/高/… labels); without them the compact
 *  English fallbacks below apply. This lib has no i18n context of its own, so
 *  dropping the parameters is what put `Fast Med` in front of Chinese users. */
export function formatModelStatusLabel(
  model: string,
  options?: {
    defaultEffort?: string
    effortLabel?: string
    fastLabel?: string
    fastMode?: boolean
    reasoningEffort?: string
  }
): string {
  const name = displayModelName(model)

  if (!model.trim()) {
    return name
  }

  const parts: string[] = []

  // Fast is shown when the speed=fast param is on (options.fastMode) OR the
  // active model is a `…-fast` variant (fast via a separate model id).
  if (options?.fastMode || /-fast$/i.test(modelBaseId(model))) {
    parts.push(options?.fastLabel || 'Fast')
  }

  // Always surface the effort (empty = Hermes default of medium) so the
  // current reasoning level is visible at a glance, not just when non-default.
  parts.push(
    options?.effortLabel ||
      reasoningEffortLabel(options?.reasoningEffort || options?.defaultEffort || '') ||
      'Med'
  )

  return `${name} · ${parts.join(' ')}`
}
