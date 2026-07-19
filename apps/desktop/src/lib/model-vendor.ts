import { modelBaseId } from '@/lib/model-status-label'

/** LLM vendors the picker can visually brand (see ui/provider-icon.tsx). */
export type VendorKey =
  | 'claude'
  | 'deepseek'
  | 'doubao'
  | 'gemini'
  | 'grok'
  | 'hunyuan'
  | 'kimi'
  | 'longcat'
  | 'meta'
  | 'mimo'
  | 'minimax'
  | 'mistral'
  | 'openai'
  | 'qwen'
  | 'stepfun'
  | 'zhipu'

// Ordered: the first matching pattern wins. Patterns run against the
// lowercased, provider-prefix-stripped model id (modelBaseId — the same
// splitter every display surface uses), so `anthropic/claude-…` and
// `deepseek-v4-pro-APEX` resolve like their bare ids. Order guards the known
// near-collisions (`mimo` before `minimax`, `doubao`/`seed` before `stepfun`).
const VENDOR_MATCHERS: ReadonlyArray<readonly [VendorKey, RegExp]> = [
  ['deepseek', /deepseek/],
  ['kimi', /kimi|moonshot/],
  ['zhipu', /glm|zhipu|chatglm/],
  ['qwen', /qwen|qwq|qvq/],
  ['doubao', /doubao|(^|-)seed-/],
  ['hunyuan', /hunyuan|^hy\d/],
  ['stepfun', /(^|-)step[-\d]/],
  ['mimo', /mimo/],
  ['minimax', /minimax|abab/],
  ['longcat', /longcat/],
  ['claude', /claude|anthropic|opus|sonnet|haiku|fable/],
  ['openai', /gpt|codex|openai|^o[134]/],
  ['gemini', /gemini|gemma/],
  ['grok', /grok/],
  ['meta', /llama/],
  ['mistral', /mistral/]
]

function matchVendor(text: string): VendorKey | null {
  for (const [vendor, pattern] of VENDOR_MATCHERS) {
    if (pattern.test(text)) {
      return vendor
    }
  }

  return null
}

/** Resolve the LLM vendor behind a model id for brand display (icon tiles).
 *  Falls back to the provider name/slug when the id alone is anonymous
 *  (e.g. BYOK endpoints serving `my-tuned-model`); null → neutral tile. */
export function modelVendor(modelId: string, providerHint?: string): VendorKey | null {
  const byId = matchVendor(modelBaseId(modelId).toLowerCase())

  if (byId) {
    return byId
  }

  return providerHint ? matchVendor(providerHint.trim().toLowerCase()) : null
}
