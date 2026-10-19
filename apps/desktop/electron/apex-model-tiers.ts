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

import { MANAGED_PROVIDER_NAME } from './apex-relay-key-anchors'

export const MODEL_TIER_ALIASES = ['apex-flash', 'apex-pro', 'apex-max']
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

/** The managed default a new install seeds: the Flash alias once tiers are on. */
export function managedDefaultModel(env: Record<string, string | undefined>, legacyDefault: string): string {
  return isModelTiersEnabled(env) ? TIER_DEFAULT_MANAGED_MODEL : legacyDefault
}

/**
 * The id WRITTEN to config for the managed model (collision-free with the
 * built-in catalogs). Precedence:
 *   1. explicit APEXNODES_MANAGED_MODEL_DISPLAY override
 *   2. a tier alias, already collision-free, reaches the relay as-is
 *   3. when only APEXNODES_MANAGED_MODEL is overridden (e.g. staging), derive a
 *      collision-free id by appending the `-APEX` brand suffix to it
 *   4. the prod default display name
 */
export function managedModelDisplay(
  env: Record<string, string | undefined>,
  model: string,
  defaultDisplay: string
): string {
  const explicit = String(env.APEXNODES_MANAGED_MODEL_DISPLAY || '').trim()

  if (explicit) {
    return explicit
  }

  if (isModelTierAlias(model)) {
    return model.toLowerCase()
  }

  return env.APEXNODES_MANAGED_MODEL ? `${model}-APEX` : defaultDisplay
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

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Boot migration: with tiers on, an assistant still on a pre-tier managed id
 * (the `-APEX` seed, or a model picked from the old APEX shelf) moves to the
 * Flash alias, so the tier the UI shows is the tier the relay routes. Only the
 * top-level `model:` block is touched, and only when it points at the managed
 * relay (named custom provider, or bare `custom` on the relay base_url). The
 * user's own provider or endpoint is never rewritten.
 */
export function migrateManagedModelToTierYaml(raw: string, relayBaseUrl: string) {
  const unchanged = { changed: false, from: '', next: raw }
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

  if (!onRelay || !current || !current.value || isModelTierAlias(current.value)) {
    return unchanged
  }

  const next = [...lines]
  next[current.index] = `  default: ${TIER_DEFAULT_MANAGED_MODEL}`

  return { changed: true, from: current.value, next: next.join('\n') }
}

/**
 * The config heal's tier step (main.ts healConfigYamlProductBlocks): returns
 * the possibly-migrated source and records what moved in `fixed`. A no-op while
 * tiers are off or without a managed credential.
 */
export function healManagedModelTier(
  raw: string,
  managed: { baseUrl?: string; key?: string },
  relayBaseUrl: string,
  env: Record<string, string | undefined>,
  fixed: string[]
): string {
  if (!managed.key || !isModelTiersEnabled(env)) {
    return raw
  }

  const heal = migrateManagedModelToTierYaml(raw, managed.baseUrl || relayBaseUrl)

  if (heal.changed) {
    fixed.push(`model(tier:${heal.from}→flash)`)
  }

  return heal.next
}
