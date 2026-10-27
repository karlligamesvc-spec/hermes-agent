/**
 * apex-model-tiers.ts — APEX model tiers: Flash / Pro / Max (hc-960).
 *
 * Kael 2026-10-19: no model picker; every assistant runs on a tier and the
 * relay maps each alias to its platform model (catalog `upstream_model`), so
 * swapping the model behind a tier needs no desktop release. The aliases are
 * written to config verbatim: they collide with no built-in catalog, and the
 * relay matches `body.model` against the plan's allowed list exactly, so the
 * `-APEX` sentinel would make every tier fall through to the plan default.
 *
 * Pure, electron-free helpers (like apex-managed.ts). Renderer twin of the
 * aliases: src/lib/model-tiers.ts (MODEL_TIER_ALIAS).
 */

import { applyHypihubApexSwitch, HYPIHUB_APEX_ACTIVE_ENV } from './apex-hypihub'
import { applyMultiBotSwitch, MULTI_BOT_ACTIVE_ENV } from './apex-multi-bot'
import { MANAGED_PROVIDER_NAME } from './apex-relay-key-anchors'
import { applySingleThreadSwitch, isSingleThreadActive, SINGLE_THREAD_ACTIVE_ENV } from './apex-single-thread'

export const MODEL_TIER_ALIASES = ['apex-flash', 'apex-pro', 'apex-max']

// The managed default of every APEX install, tiers on or off (hc-1010): the
// relay serves the aliases since hc-959, and an older relay treats an alias it
// does not know like the `-APEX` seed it replaced (not on the allowed list →
// the account's default model), so nothing depends on the switch any more.
export const TIER_DEFAULT_MANAGED_MODEL = 'apex-flash'

// The tier switch. OFF by default until the relay serves the aliases (the WP2
// server work); then the platform turns it on for every install through the
// admin-managed client config (`desktop_features.model_tiers`, applied at the
// next launch), or a tester sets APEXNODES_MODEL_TIERS=1. An explicit 0/false
// in the env wins over the platform so a single install can opt out. Max opens
// later (after the quota cost factor is enforced and legal confirms) behind its
// own switch.
export const MODEL_TIERS_ENV = 'APEXNODES_MODEL_TIERS'
export const MODEL_TIER_MAX_ENV = 'APEXNODES_MODEL_TIER_MAX'

// The managed relay as config.yaml names it: bare `custom` (the seed) or the
// named custom provider a picker switch persists (`custom:<name>`).
const MANAGED_PROVIDER = 'custom'
const MANAGED_PROVIDER_SLUG = `custom:${MANAGED_PROVIDER_NAME.toLowerCase().replace(/ /g, '-')}`

function envSwitch(env: Record<string, string | undefined>, name: string): boolean | null {
  const raw = String(env?.[name] ?? '')
    .trim()
    .toLowerCase()

  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true
  }

  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false
  }

  return null
}

/** Strict opt-in: before the relay serves the aliases a tier pick would
 *  silently land on the plan default. */
export function isModelTiersEnabled(env: Record<string, string | undefined> = {}): boolean {
  return envSwitch(env, MODEL_TIERS_ENV) === true
}

/** The later Max switch; meaningless while tiers are off. */
export function isModelTierMaxEnabled(env: Record<string, string | undefined> = {}): boolean {
  return isModelTiersEnabled(env) && envSwitch(env, MODEL_TIER_MAX_ENV) === true
}

export function isModelTierAlias(model: unknown): boolean {
  return MODEL_TIER_ALIASES.includes(
    String(model || '')
      .trim()
      .toLowerCase()
  )
}

/** Both switches, as `hermes:managed:status` reports them to the renderer. */
export function modelTierStatus(env: Record<string, string | undefined>) {
  return { modelTiers: isModelTiersEnabled(env), modelTierMax: isModelTierMaxEnabled(env) }
}

/**
 * The id WRITTEN to config for the managed model (collision-free with the
 * built-in catalogs). Precedence:
 *   1. explicit APEXNODES_MANAGED_MODEL_DISPLAY override
 *   2. a tier alias — the default — is already collision-free and reaches the
 *      relay as-is (`apex-flash-APEX` would match no allowed model)
 *   3. a raw routed id from an APEXNODES_MANAGED_MODEL override (e.g.
 *      staging) gets the `-APEX` brand suffix so it cannot collide
 */
export function managedModelDisplay(env: Record<string, string | undefined>, model: string): string {
  const explicit = String(env.APEXNODES_MANAGED_MODEL_DISPLAY || '').trim()

  if (explicit) {
    return explicit
  }

  if (isModelTierAlias(model)) {
    return model.toLowerCase()
  }

  return `${model}-APEX`
}

/** A provision-key `model` is honored only when it is already collision-free:
 *  an `-APEX` display id, or (tiers on) a tier alias. */
export function managedConfigModel(
  env: Record<string, string | undefined>,
  override: string,
  fallback: string
): string {
  return /-APEX$/i.test(override) || (isModelTiersEnabled(env) && isModelTierAlias(override)) ? override : fallback
}

/**
 * The tier switches as the platform client config carries them
 * (`payload.desktop_features.{model_tiers, model_tier_max}`). Only a literal
 * `true` turns a switch on; anything else (absent, garbage) is off.
 */
export function modelTierSwitchesFromClientConfig(payload: unknown) {
  const features =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { desktop_features?: unknown }).desktop_features
      : null

  const flags =
    features && typeof features === 'object' && !Array.isArray(features) ? (features as Record<string, unknown>) : {}

  return { modelTierMax: flags.model_tier_max === true, modelTiers: flags.model_tiers === true }
}

/**
 * Settle the switches for this launch into the env every later reader consults
 * (resolveApexEndpoints, the status IPC, the config heal). An env value the user
 * or a test already set wins; otherwise the platform client config decides.
 * Returns the env keys it set (each also reported through `log`).
 */
export function applyModelTierSwitches(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): string[] {
  const platform = modelTierSwitchesFromClientConfig(clientConfigPayload)
  const set: string[] = []

  for (const [name, on] of [
    [MODEL_TIERS_ENV, platform.modelTiers],
    [MODEL_TIER_MAX_ENV, platform.modelTierMax]
  ] as const) {
    if (on && envSwitch(env, name) === null) {
      env[name] = '1'
      set.push(name)
      log(`[client-config] ${name}=1 from platform desktop_features`)
    }
  }

  return set
}

/** Every launch-time `desktop_features` switch main settles into the env: the
 *  tier switches above, hc-1015 single-thread (apex-single-thread.ts),
 *  APEX-hosted Hypit generation (apex-hypihub.ts) and hc-1077 several
 *  assistants (apex-multi-bot.ts). */
export function applyDesktopFeatureSwitches(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): string[] {
  const set = applyModelTierSwitches(env, clientConfigPayload, log)
  const singleThread = applySingleThreadSwitch(env, clientConfigPayload, log) ? [SINGLE_THREAD_ACTIVE_ENV] : []
  const hosted = applyHypihubApexSwitch(env, clientConfigPayload, log) ? [HYPIHUB_APEX_ACTIVE_ENV] : []
  const multiBot = applyMultiBotSwitch(env, clientConfigPayload, log) ? [MULTI_BOT_ACTIVE_ENV] : []

  return [...set, ...singleThread, ...hosted, ...multiBot]
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '')
}

/** The strongest tier at or below `alias` that the account's plan grants
 *  (`entitled`: the relay's listing, apex-relay-tiers.ts), Flash when none is.
 *  An unknown listing (null, or one naming no tier) keeps `alias`. */
function cappedTierAlias(alias: string, entitled: null | readonly string[]): string {
  const granted = new Set((entitled ?? []).map(model => model.toLowerCase()))

  if (!MODEL_TIER_ALIASES.some(tier => granted.has(tier))) {
    return alias
  }

  const fits = MODEL_TIER_ALIASES.slice(0, MODEL_TIER_ALIASES.indexOf(alias) + 1).filter(tier => granted.has(tier))

  return fits.at(-1) ?? TIER_DEFAULT_MANAGED_MODEL
}

/**
 * The managed main model a config heal settles on.
 *
 * Tier mode (hc-960): a pre-tier id (the `-APEX` seed, or a model picked from
 * the old APEX shelf) moves to the Flash alias, so the tier the UI shows is the
 * tier the relay routes; a tier alias stays as it is.
 *
 * Single-thread mode (hc-1072): a tier the user picked stays, unless the plan
 * does not grant it (per `entitled`) — then it drops to the strongest one the
 * plan does. A pre-tier id was never a tier pick, Pro-sounding or not (the
 * 06-27..10-08 seed `deepseek-v4-pro-APEX` was the install default): it moves
 * to Flash, as in tier mode.
 */
export function settledManagedModel(current: string, singleThread: boolean, entitled: null | readonly string[] = null) {
  if (!isModelTierAlias(current)) {
    return TIER_DEFAULT_MANAGED_MODEL
  }

  return singleThread ? cappedTierAlias(current.toLowerCase(), entitled) : current
}

/**
 * Boot/watch migration of the managed main model (settledManagedModel). Only
 * the top-level `model:` block is touched, and only when it points at the
 * managed relay (named custom provider, or bare `custom` on the relay
 * base_url). The user's own provider or endpoint is never rewritten.
 */
export function migrateManagedModelToTierYaml(
  raw: string,
  relayBaseUrl: string,
  singleThread = false,
  entitled: null | readonly string[] = null
) {
  const unchanged = { changed: false, from: '', next: raw, to: '' }
  const lines = raw.split('\n')
  const start = lines.findIndex(line => /^model:\s*$/.test(line))

  if (start < 0) {
    return unchanged
  }

  let end = start + 1

  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) {
    end += 1
  }

  const field = (name: string) => {
    for (let index = start + 1; index < end; index += 1) {
      const match = lines[index].match(new RegExp(`^  ${name}:\\s*(.*?)\\s*$`))

      if (match) {
        return { index, value: match[1].replace(/^(['"])(.*)\1$/, '$2').trim() }
      }
    }

    return null
  }

  const provider = (field('provider')?.value ?? '').toLowerCase()
  const baseUrl = trimTrailingSlash(field('base_url')?.value ?? '')
  const current = field('default')

  const onRelay =
    provider === MANAGED_PROVIDER_SLUG ||
    (provider === MANAGED_PROVIDER && Boolean(relayBaseUrl) && baseUrl === trimTrailingSlash(relayBaseUrl))

  if (!onRelay || !current || !current.value) {
    return unchanged
  }

  const to = settledManagedModel(current.value, singleThread, entitled)

  if (to.toLowerCase() === current.value.toLowerCase()) {
    return unchanged
  }

  const next = [...lines]
  next[current.index] = `  default: ${to}`

  return { changed: true, from: current.value, next: next.join('\n'), to }
}

/**
 * The config heal's tier step (main.ts healConfigYamlProductBlocks): returns
 * the possibly-migrated source and records what moved in `fixed`. A no-op while
 * tiers and single-thread mode are both off, or without a managed credential.
 * `entitled`: the tiers the relay last listed for this credential's key
 * (apex-relay-tiers.ts RelayTierMemo), read only in single-thread mode.
 */
export function healManagedModelTier(
  raw: string,
  managed: { baseUrl?: string; key?: string },
  relayBaseUrl: string,
  env: Record<string, string | undefined>,
  fixed: string[],
  entitled: null | readonly string[] = null
): string {
  const singleThread = isSingleThreadActive(env)

  if (!managed.key || (!isModelTiersEnabled(env) && !singleThread)) {
    return raw
  }

  const heal = migrateManagedModelToTierYaml(raw, managed.baseUrl || relayBaseUrl, singleThread, entitled)

  if (heal.changed) {
    fixed.push(`model(${singleThread ? 'single-thread' : 'tier'}:${heal.from}→${heal.to.replace(/^apex-/, '')})`)
  }

  return heal.next
}
