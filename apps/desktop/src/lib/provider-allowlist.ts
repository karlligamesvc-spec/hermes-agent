import type { ModelOptionProvider } from '@/types/hermes'

// ApexNodes is a China-first managed product, so the model picker only surfaces
// two kinds of provider:
//
//   1. The APEX-NODES.COM managed relay (the zero-key default). The relay is
//      registered as a *named custom provider* (electron/apex-managed.cjs:
//      MANAGED_PROVIDER_NAME = 'Apex-nodes.com'), so the runtime emits it with
//      slug `custom:apex-nodes.com` (custom_provider_slug() in the runtime's
//      hermes_cli/providers.py: `"custom:" + name.lower().replace(" ", "-")`).
//      A bare `custom` row can also appear for a user's own OpenAI-compatible
//      endpoint. Both are kept — the bare/`custom:*` slugs ARE the BYOK escape
//      hatch for adding a native key behind an OpenAI-compatible URL.
//
//   2. Domestic (国产 / mainland-China) LLM providers, so a user can BYOK their
//      own native key (DeepSeek, Qwen/通义, GLM/智谱, Kimi/Moonshot, MiniMax,
//      StepFun, Xiaomi MiMo, Tencent …). The "编辑模型 / Add provider" flow for
//      these stays intact.
//
// Everything foreign is hidden (OpenAI, Anthropic, xAI/Grok, Google/Gemini,
// GitHub Copilot, Mistral, Cohere, OpenRouter, Nous, Bedrock, Azure, NVIDIA,
// Hugging Face, Ollama, Groq, Together, Fireworks, …) — even if the user has a
// key configured, it won't show up in the picker.
//
// The runtime's PROVIDER_REGISTRY (hermes_cli/auth.py) has no per-provider
// region/origin field to filter on, so this is an explicit slug allowlist that
// mirrors the existing China-first split already used by PROVIDER_GROUPS
// (settings/constants.ts, domestic priority 1–9). Verify any new id against the
// runtime registry before adding it here.
//
// To add a domestic provider: drop its registry slug into DOMESTIC_PROVIDER_SLUGS.

/** Domestic (mainland-China stable, no VPN) provider slugs from the runtime's
 *  PROVIDER_REGISTRY (hermes_cli/auth.py). Lowercase; matched case-insensitively. */
export const DOMESTIC_PROVIDER_SLUGS: ReadonlySet<string> = new Set([
  'deepseek', // DeepSeek (V3.x / R1) — the recommended default
  'zai', // Z.AI / GLM (Zhipu)
  'kimi-coding', // Kimi / Moonshot (international platform.moonshot.ai)
  'kimi-coding-cn', // Kimi / Moonshot (China platform.moonshot.cn)
  'alibaba', // Qwen Cloud / DashScope (通义千问)
  'alibaba-coding-plan', // Alibaba Cloud Coding Plan (Qwen)
  'qwen-oauth', // Qwen OAuth
  'minimax', // MiniMax (international)
  'minimax-oauth', // MiniMax OAuth
  'minimax-cn', // MiniMax (China)
  'stepfun', // StepFun Step Plan
  'xiaomi', // Xiaomi MiMo
  'tencent-tokenhub' // Tencent TokenHub
])

/** The ApexNodes managed-relay provider slug — the zero-key "platform" default.
 *  The relay is registered as the named custom provider "Apex-nodes.com"
 *  (electron/apex-managed.cjs MANAGED_PROVIDER_NAME), which the runtime lowercases
 *  + hyphenates into this slug (hermes_cli/providers.py custom_provider_slug).
 *  It is the single reliable signal for a *platform* model (billed via the user's
 *  cloud account through the relay) vs a *BYO* model (the user's own key). Neither
 *  `is_user_defined` (true for the relay too) nor the `-APEX` display suffix (only
 *  the default carries it) distinguishes them — the slug does. */
export const MANAGED_PROVIDER_SLUG = 'custom:apex-nodes.com'

/** True when a provider row is the ApexNodes managed relay (platform models),
 *  as opposed to a user's own BYO provider. Keyed on the slug, with the display
 *  name as a belt-and-suspenders fallback (mirrors model-menu-panel's label). */
export function isManagedProviderSlug(slug: string | null | undefined, name?: string | null): boolean {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()

  if (normalized === MANAGED_PROVIDER_SLUG) {
    return true
  }

  return /^apex-?nodes/i.test(String(name || '').trim())
}

/** True when a provider slug is the ApexNodes managed relay or a user's own
 *  custom / local OpenAI-compatible endpoint. Covers the bare `custom` slug and
 *  any named `custom:<name>` (e.g. `custom:apex-nodes.com`). */
function isCustomOrManagedSlug(slug: string): boolean {
  return slug === 'custom' || slug.startsWith('custom:')
}

/** Whether a provider should appear in the China-first model picker: the
 *  APEX-NODES.COM managed relay / a custom BYOK endpoint, or a domestic
 *  provider. Foreign providers return false. */
export function isPickerVisibleProvider(slug: string): boolean {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()

  if (!normalized) {
    return false
  }

  return isCustomOrManagedSlug(normalized) || DOMESTIC_PROVIDER_SLUGS.has(normalized)
}

/** Whether a provider's MODELS should be listed in the model picker.
 *
 *  hc-638: narrower than isPickerVisibleProvider on purpose. Built-in vendor
 *  rows (DeepSeek, Zhipu, Moonshot, …) used to appear in the picker one section
 *  below the managed relay, with confusingly similar names — "DeepSeek V4 Flash"
 *  (managed, billed to the platform quota) directly above "DeepSeek Chat" (the
 *  vendor direct, billed to the user's own key). Same word, different route,
 *  different wallet, no visual distinction. Kael's call: drop the built-in rows
 *  from the picker; a user who wants a vendor direct adds it as a custom
 *  endpoint, which is explicit about being theirs.
 *
 *  This is a SEPARATE predicate rather than a change to isPickerVisibleProvider
 *  because that one has two other consumers with a different question:
 *  providers-settings.tsx uses it to decide which OAuth sign-in rows to render
 *  (:386/:401), and DOMESTIC_PROVIDER_SLUGS to decide which vendors get a
 *  key-entry card. Narrowing the shared predicate would have removed the ability
 *  to CONFIGURE or SIGN IN TO a vendor, not just the ability to pick its models
 *  — three questions wearing one name. */
export function isPickerVisibleModelProvider(slug: string): boolean {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()

  return normalized ? isCustomOrManagedSlug(normalized) : false
}

/** Keep only the providers whose models the picker should show (APEX-NODES.COM +
 *  custom endpoints), with the anonymous bare-`custom` alias removed.
 *  Order is preserved. */
export function filterPickerProviders(providers: ModelOptionProvider[]): ModelOptionProvider[] {
  return dropAliasedCustomRow(providers.filter(provider => isPickerVisibleModelProvider(provider.slug)))
}

const normalizeSlug = (slug: string | null | undefined): string =>
  String(slug || '')
    .trim()
    .toLowerCase()

/** Drop the bare `custom` row when a named `custom:<name>` row is present.
 *
 *  hc-598: the managed relay is registered under the BARE `custom` slug with a
 *  named `custom_providers` entry beside it, so the runtime lists it once as
 *  `custom:apex-nodes.com` and then — because no row is literally named
 *  `custom` — synthesizes a second, anonymous row for the "missing" current
 *  provider (hermes_cli/inventory.py `_append_unconfigured_rows`). Same
 *  endpoint, twice, the second time labelled with the implementation word
 *  "Custom endpoint" and falsely marked unauthenticated.
 *
 *  The bare slug carries no endpoint identity of its own — its address lives in
 *  `model.base_url`, and upstream resolves it by falling back to a saved
 *  `custom_providers` entry (`resolve_custom_provider`, GH #17478). So whenever
 *  ANY named custom row exists, the bare row is an alias of one of them and
 *  never a distinct endpoint. With no named rows it is the only representation
 *  of the user's own endpoint and is kept.
 *
 *  The root fix is the runtime seam `apex_overlay/custom_row_dedupe.py`; this is
 *  the renderer's guard, because the shell ships on its own cadence and will
 *  run against engines built before that seam existed. */
export function dropAliasedCustomRow(providers: ModelOptionProvider[]): ModelOptionProvider[] {
  if (!providers.some(provider => normalizeSlug(provider.slug).startsWith('custom:'))) {
    return providers
  }

  return providers.filter(provider => normalizeSlug(provider.slug) !== 'custom')
}

/** Names the runtime gives a custom endpoint that has none of its own:
 *  `_PROVIDER_LABELS["custom"]` in hermes_cli/models.py, plus the bare slug that
 *  reaches the UI when a row is assembled without a label. */
const IMPLEMENTATION_PROVIDER_NAMES: ReadonlySet<string> = new Set(['custom', 'custom endpoint'])

/** The label to render for a provider row.
 *
 *  hc-598: "CUSTOM ENDPOINT" is an internal word, not product language, and it
 *  is what the model menu shouted at users whose managed relay arrived as an
 *  unnamed row. A custom endpoint that HAS a name (the managed relay's
 *  "Apex-nodes.com", a user's "My Ollama") shows it; one that does not is named
 *  by its address, which is what the user typed and needs no translation.
 *  `fallback` — a translated "your endpoint" — covers the remaining case:
 *  unnamed AND address-less. */
export function providerDisplayName(provider: ModelOptionProvider, fallback: string): string {
  const name = String(provider.name || '').trim()

  if (name && !IMPLEMENTATION_PROVIDER_NAMES.has(name.toLowerCase())) {
    return name
  }

  return endpointHost(provider.api_url) || fallback
}

/** Host (with port) of an endpoint URL — `https://apex-nodes.com/relay/v1` →
 *  `apex-nodes.com`. Empty when there is nothing parseable to show. */
function endpointHost(url: string | null | undefined): string {
  const raw = String(url || '').trim()

  if (!raw) {
    return ''
  }

  try {
    return new URL(raw).host
  } catch {
    // Not an absolute URL (a bare `127.0.0.1:8081`) — take the authority slice.
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  }
}
