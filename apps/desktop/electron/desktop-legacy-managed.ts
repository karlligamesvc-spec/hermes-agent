import yaml from 'js-yaml'

import { auditManagedRelayKeyAnchors, persistRelayKeyToConfigYaml } from './apex-relay-key-anchors'
import { type DesktopModelMutationCoordinator, type ManagedModelAssignment, ModelMutationError, type ResolvedModelTarget } from './desktop-model-mutations'

export interface LegacyManagedBinding { provider: string; endpointId?: string; keyEnv?: string }
const ENDPOINT_NAME = 'APEX Desktop managed'

function endpoint(value: string): string {
  const url = new URL(value)
  url.hash = ''

  return url.toString().replace(/\/+$/, '')
}

function configFromRaw(value: any): { raw: string; config: any } {
  if (typeof value?.yaml !== 'string') {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}
  let config: any

  try {config = value.yaml.trim() ? yaml.load(value.yaml) : {}} catch {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}

  if (!config || typeof config !== 'object' || Array.isArray(config)) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}

  return { raw: value.yaml, config }
}

function credentialRows(config: any): any[] {
  return [config.model, ...Object.values(config.providers || {}),
    ...(Array.isArray(config.custom_providers) ? config.custom_providers : Object.values(config.custom_providers || {})),
    ...Object.values(config.auxiliary || {})].filter(value => value && typeof value === 'object')
}

function rowUrl(row: any, config?: any): string {
  if (config && (row === config.model || (Array.isArray(config.custom_providers) && config.custom_providers.includes(row)) ||
    Object.values(config.auxiliary || {}).includes(row))) {return row?.base_url || ''}

  return row?.api || row?.url || row?.base_url || ''
}

function matchingRows(config: any, baseUrl: string): any[] {
  const rows = credentialRows(config)

  return rows.filter(row => {
    const url = rowUrl(row, config)

    // A raw URL template can resolve to the managed host. Legacy cannot prove
    // that binding, so refuse before rotating the cloud credential.
    if (typeof url === 'string' && url.includes('${')) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED')}

    try {return endpoint(String(url)) === endpoint(baseUrl)} catch {return false}
  })
}

function selectedMainEndpoint(config: any, ownedProvider?: string): string {
  const nested = config.model?.default || config.model?.model
  const requested = String(config.model?.provider || nested?.provider || '').trim().toLowerCase().replaceAll(' ', '-')

  // Built-ins, auto and bare inline endpoints have additional environment/OAuth
  // routing. A raw URL does not prove they consume the managed credential.
  if (requested !== 'custom' && !requested.startsWith('custom:') && requested !== ownedProvider) {return ''}

  const entries = [...Object.entries(config.providers || {}).map(([key, value]) => ({ key, value, keyed: true })),
    ...(Array.isArray(config.custom_providers) ? config.custom_providers.map(value => ({ key: value?.provider_key || '', value, keyed: false })) : [])]

  const matches = entries.filter(({ key, value, keyed }: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false}

    // Only unambiguously enabled keyed entries are eligible for automatic
    // repair. Legacy enabled is not a Runtime disable switch.
    if (keyed && value.enabled !== undefined && value.enabled !== true) {return false}

    if (!keyed && typeof value.name !== 'string') {return false}

    if (typeof rowUrl(value, config) !== 'string' || !rowUrl(value, config).trim()) {return false}

    return [key, value.name].some(alias => {
      const normalized = String(alias || '').trim().toLowerCase().replaceAll(' ', '-')
      const suffix = normalized.startsWith('custom:') ? normalized.slice(7) : normalized

      return normalized && [normalized, suffix, `custom:${normalized}`, `custom:${suffix}`].includes(requested)
    })
  })

  // Alias collisions can also mix credential-pool identities at the same URL.
  // Do not emulate a first-entry guess for recovery.
  if (matches.length > 1) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED')}

  return matches.length === 1 ? rowUrl(matches[0].value, config) : ''
}

/** A healthy Native key does not prove that the captured Runtime consumes it. */
export async function managedRuntimeNeedsRepair(target: ResolvedModelTarget, assignment: ManagedModelAssignment,
  coordinator?: Pick<DesktopModelMutationCoordinator, 'managedEndpointId' | 'ownsLegacyEndpoint'>): Promise<boolean> {
  const { config } = configFromRaw(await target.request('/api/config/raw', undefined, {}, 'GET'))
  target.assertCurrent?.()
  const id = coordinator?.managedEndpointId()
  const ownedProvider = id && coordinator?.ownsLegacyEndpoint(target, id) ? id : undefined
  const modelUrl = selectedMainEndpoint(config, ownedProvider)

  if (typeof modelUrl !== 'string') {return false}

  try {if (endpoint(modelUrl) !== endpoint(assignment.base_url)) {return false}} catch {return false}

  let repair = false

  for (const row of matchingRows(config, assignment.base_url)) {
    // Commands cannot be independently inspected or safely overridden by a
    // recovery probe. Keep that choice and require an explicit Runtime update.
    if (row.key_cmd) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}
    const reference = typeof row.api_key === 'string' ? /^\$\{([^}]+)\}$/.exec(row.api_key) : null
    const pointer = row.key_env || row.api_key_env || reference?.[1]

    if (pointer) {
      if (typeof pointer !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pointer)) {
        throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)
      }

      const resolved = await target.request('/api/env/reveal', { key: pointer }, {})
      target.assertCurrent?.()

      if (resolved?.key !== pointer || typeof resolved.value !== 'string') {
        throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)
      }

      repair ||= resolved.value !== assignment.api_key
    } else {
      repair ||= row.api_key !== assignment.api_key
    }
  }

  return repair
}

/** Read-only, before provision: choose a proven old API without overriding BYOK. */
export async function prepareLegacyManagedBinding(coordinator: DesktopModelMutationCoordinator,
  target: ResolvedModelTarget, baseUrl: string): Promise<LegacyManagedBinding> {
  const { config } = configFromRaw(await target.request('/api/config/raw', undefined, {}, 'GET'))
  target.assertCurrent?.()
  const id = coordinator.managedEndpointId()
  const keyEnv = `HERMES_CUSTOM_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const existing = config.providers?.[id]
  const owned = coordinator.ownsLegacyEndpoint(target, id)

  const fallbackRows = [...(Array.isArray(config.fallback_model) ? config.fallback_model : [config.fallback_model]),
    ...(Array.isArray(config.fallback_providers) ? config.fallback_providers : [])]

  for (const row of [...credentialRows(config), ...fallbackRows].filter(value => value && typeof value === 'object')) {
    const referencesOwnedKey = row.key_env === keyEnv || row.api_key_env === keyEnv || row.api_key === `\${${keyEnv}}`

    if (referencesOwnedKey && !(owned && (row === existing ||
      (row === config.model && config.model.provider === id)) && endpoint(rowUrl(row, config)) === endpoint(baseUrl))) {
      throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)
    }
  }

  if (existing && (!owned || existing.name !== ENDPOINT_NAME ||
    endpoint(String(existing.base_url || '')) !== endpoint(baseUrl) || existing.key_cmd ||
    (existing.key_env && existing.key_env !== keyEnv) || existing.api_key_env)) {
    throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)
  }

  const rows = matchingRows(config, baseUrl)

  for (const row of rows) {
    const ownPointer = owned && row.key_env === keyEnv &&
      (row === existing || (row === config.model && config.model.provider === id))

    if (row.key_cmd || row.api_key_env || (row.key_env && !ownPointer) ||
      (typeof row.api_key === 'string' && row.api_key.includes('${') && !ownPointer)) {
      throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)
    }
  }

  try {
    const response = await target.request('/api/providers/custom-endpoints', undefined, {}, 'GET')
    target.assertCurrent?.()

    if (!Array.isArray(response?.endpoints)) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)}
    const collision = response.endpoints.find(item => item.id === id)

    if (collision && (!existing || !owned)) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}

    if (!owned) {
      let stored: any = null

      try {stored = await target.request('/api/env/reveal', { key: keyEnv }, {})} catch (error: any) {
        if (error?.statusCode !== 404) {throw error}
      }

      target.assertCurrent?.()

      if (stored && (stored.key !== keyEnv || typeof stored.value !== 'string')) {
        throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)
      }

      if (stored?.value) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}
    }

    return { provider: id, endpointId: id, keyEnv }
  } catch (error: any) {
    if (error?.statusCode !== 404) {throw error}
    target.assertCurrent?.()
    // The older inline route can use a named matching catalog explicitly,
    // rather than bare-custom's first unrelated endpoint fallback.
    const catalog = config.custom_providers
    const keyed = Object.entries(config.providers || {}).filter(([, row]: any) => row && typeof row === 'object' && row.enabled !== false && rowUrl(row))
    const keyedMatch = keyed.find(([, row]) => rows.includes(row))
    const matching = Array.isArray(catalog) ? catalog.find(row => rows.includes(row)) : null
    const identity = String(keyedMatch?.[0] || matching?.provider_key || matching?.name || '').trim().toLowerCase().replaceAll(' ', '-')
    const provider = identity ? (identity.startsWith('custom:') ? identity : `custom:${identity}`) : 'custom'
    const unrelated = keyed.some(([, row]) => !rows.includes(row)) || (Array.isArray(catalog) && catalog.some(row => !rows.includes(row)))

    if (!keyedMatch && !matching && unrelated) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}

    return { provider }
  }
}

/** Released legacy APIs settle their writers, then independent reads prove binding. */
export async function applyLegacyManagedBinding(args: {
  coordinator: DesktopModelMutationCoordinator; target: ResolvedModelTarget; isCurrent: () => boolean;
  assignment: ManagedModelAssignment; binding: LegacyManagedBinding
}) {
  const { coordinator, target, assignment, binding, isCurrent } = args

  const assertCurrent = () => {
    if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
    target.assertCurrent?.()
  }

  if (binding.endpointId) {
    const created = await coordinator.run(target, isCurrent, headers => target.request('/api/providers/custom-endpoints', {
      id: binding.endpointId, name: ENDPOINT_NAME, base_url: assignment.base_url, model: assignment.model,
      api_key: assignment.api_key, make_default: true, discover_models: true
    }, headers), result => result?.ok === true && result.id === binding.endpointId &&
      Array.isArray(result.endpoints) && result.current?.provider === binding.endpointId && result.current?.model === assignment.model)

    assertCurrent()

    if (created.id !== binding.endpointId) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)}
    coordinator.ownLegacyEndpoint(target, binding.endpointId)
  }

  const requested = { ...assignment, provider: binding.provider }

  const applied = await coordinator.run(target, isCurrent,
    headers => target.request('/api/model/set', requested, headers), result => result?.ok === true && result.scope === 'main' &&
      typeof result.provider === 'string' && Boolean(result.provider) && result.model === assignment.model &&
      typeof result.base_url === 'string' && endpoint(result.base_url) === endpoint(assignment.base_url))

  assertCurrent()

  if (binding.endpointId && applied.provider !== binding.endpointId) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)}
  const source = configFromRaw(await target.request('/api/config/raw', undefined, {}, 'GET'))
  let corrected = source.raw

  const sync = persistRelayKeyToConfigYaml({ read: () => corrected, write: next => {corrected = next},
    baseUrl: assignment.base_url, key: assignment.api_key })

  if (!sync.ok) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}
  assertCurrent()

  if (corrected !== source.raw) {
    await coordinator.run(target, isCurrent, headers => target.request('/api/config/raw', { yaml_text: corrected }, headers, 'PUT'),
      result => result?.ok === true)
  }

  const actual = configFromRaw(await target.request('/api/config/raw', undefined, {}, 'GET'))
  assertCurrent()

  // This uses the real YAML decoder, not the writer/auditor's indentation walk.
  // A legal key/layout the patcher cannot address must never certify an old key.
  const staleConsumer = matchingRows(actual.config, assignment.base_url).some(row => {
    const reference = typeof row.api_key === 'string' ? /^\$\{([^}]+)\}$/.exec(row.api_key) : null
    const pointer = row.key_env || row.api_key_env || reference?.[1]

    if (row.key_cmd) {return true}

    if (pointer) {
      return pointer !== binding.keyEnv || !(row === actual.config.model ||
        (binding.endpointId && row === actual.config.providers?.[binding.endpointId]))
    }

    return row.api_key !== assignment.api_key
  })

  if (staleConsumer) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}
  const audit = auditManagedRelayKeyAnchors(actual.raw, assignment.base_url, assignment.api_key)

  if (!audit.clean || !audit.holders.length || actual.config.model?.provider !== applied.provider ||
    endpoint(String(actual.config.model?.base_url || '')) !== endpoint(assignment.base_url)) {
    throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)
  }

  if (binding.keyEnv) {
    const stored = await target.request('/api/env/reveal', { key: binding.keyEnv }, {})
    assertCurrent()

    if (stored?.key !== binding.keyEnv || stored.value !== assignment.api_key) {
      throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)
    }
  }

  return applied
}
