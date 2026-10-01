import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { INSTALLATION_ID_RE } from './desktop-installation'
import { applyLegacyManagedBinding, type LegacyManagedBinding, prepareLegacyManagedBinding } from './desktop-legacy-managed'

export interface ModelMutationScope { connectionId: string | null; profile: string | null }

export function modelMutationRequestProfile(request: { path?: string; profile?: unknown; body?: { profile?: unknown } }, fallback: string | null): string {
  const query = new URL(request.path || '', 'http://model.invalid').searchParams.get('profile')

  // Match Runtime's body-before-query profile selection and its canonical name.
  return String(request.body?.profile || query || request.profile || fallback || 'default').trim().toLowerCase()
}

interface PendingMutation { id: string; scope: ModelMutationScope; targetId: string | null; revision: number; legacyOwnedPid?: number; transportFingerprint?: string }
interface LegacySettlement { scope: ModelMutationScope; transportFingerprint: string; revision: number; provider: string; model: string }
interface OwnedLegacyEndpoint { scope: ModelMutationScope; transportFingerprint: string; id: string }
interface MutationMetadata { version: 1; authority: string; revision: number; pending: PendingMutation[]; credentialRecovery?: boolean; legacySettled?: LegacySettlement[]; ownedLegacyEndpoints?: OwnedLegacyEndpoint[] }

export class ModelMutationError extends Error {
  constructor(public code: 'MODEL_RUNTIME_UPDATE_REQUIRED' | 'MODEL_RUNTIME_UNAVAILABLE' | 'MODEL_MUTATION_SUPERSEDED', public localRuntime?: boolean) {
    super(code)
  }
}

function validScope(scope: ModelMutationScope): boolean {
  return Boolean(scope && (scope.profile === null || /^[a-zA-Z0-9_-]{1,100}$/.test(scope.profile)) &&
    (scope.connectionId === null || /^[a-zA-Z0-9_-]{1,200}$/.test(scope.connectionId)))
}

function readOwnedFile(file: string): string {
  const stat = fs.lstatSync(file)

  if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
  }

  if (process.platform !== 'win32') {fs.chmodSync(file, 0o600)}

  return fs.readFileSync(file, 'utf8')
}

function syncDirectory(directory: string): void {
  // Windows does not expose POSIX directory fsync. Rename remains atomic there.
  if (process.platform === 'win32') {return}

  const descriptor = fs.openSync(directory, 'r')

  try {fs.fsyncSync(descriptor)} finally {fs.closeSync(descriptor)}
}

/** Nonsecret Native facts. Exclusive publication survives another process/restart. */
export class ModelMutationMetadataStore {
  constructor(private file: string, private authority: () => string) {}

  private locked<T>(operation: (metadata: MutationMetadata) => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const lock = `${this.file}.lock`
    const nonce = crypto.randomUUID()
    let descriptor: number | undefined

    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        descriptor = fs.openSync(lock, 'wx', 0o600)

        try {
          fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce }))
          fs.fsyncSync(descriptor)
        } catch (error) {
          fs.closeSync(descriptor)
          descriptor = undefined
          fs.unlinkSync(lock)
          throw error
        }

        break
      } catch (error: any) {
        if (error?.code !== 'EEXIST') {throw error}

        let raw: string

        try {raw = readOwnedFile(lock)} catch (failure: any) {
          if (failure?.code === 'ENOENT') {continue}
          throw failure
        }

        if (!raw) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)

          continue
        }

        const owner = JSON.parse(raw)

        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !INSTALLATION_ID_RE.test(owner.nonce)) {
          throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
        }

        let alive = true

        try {process.kill(owner.pid, 0)} catch (failure: any) {alive = failure?.code !== 'ESRCH'}

        if (!alive) {
          // One reclaimer at a time. A contender that acquired a new live lock
          // after deletion must never have that lock removed by another reclaimer.
          let reclaim: number | undefined

          try {
            reclaim = fs.openSync(`${lock}.reclaim`, 'wx', 0o600)

            if (readOwnedFile(lock) === raw) {fs.unlinkSync(lock)}
          } catch (failure: any) {
            if (!['ENOENT', 'EEXIST'].includes(failure?.code)) {throw failure}
          } finally {
            if (reclaim !== undefined) {
              fs.closeSync(reclaim)
              fs.unlinkSync(`${lock}.reclaim`)
            }
          }
        } else {Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)}
      }
    }

    if (descriptor === undefined) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}

    try {
      const authority = this.authority()

      if (!INSTALLATION_ID_RE.test(authority)) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}

      let metadata: MutationMetadata

      try {metadata = JSON.parse(readOwnedFile(this.file))} catch (error: any) {
        if (error?.code !== 'ENOENT') {throw error}

        // Losing an established counter must not restart this authority at 0.
        if (fs.existsSync(`${this.file}.initialized`)) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}
        metadata = { version: 1, authority, revision: 0, pending: [] }
      }

      if (metadata.version !== 1 || metadata.authority !== authority || !Number.isSafeInteger(metadata.revision) ||
        metadata.revision < 0 || !Array.isArray(metadata.pending) || metadata.pending.some(item =>
          !INSTALLATION_ID_RE.test(item.id) || !validScope(item.scope) ||
          (item.targetId !== null && !INSTALLATION_ID_RE.test(item.targetId)) ||
          (item.legacyOwnedPid !== undefined && (!Number.isSafeInteger(item.legacyOwnedPid) || item.legacyOwnedPid <= 0)) ||
          (item.transportFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(item.transportFingerprint)) ||
          !Number.isSafeInteger(item.revision) || item.revision <= 0 || item.revision > metadata.revision) ||
        (metadata.credentialRecovery !== undefined && typeof metadata.credentialRecovery !== 'boolean') ||
        (metadata.ownedLegacyEndpoints !== undefined && (!Array.isArray(metadata.ownedLegacyEndpoints) || metadata.ownedLegacyEndpoints.some(item =>
          !validScope(item.scope) || !/^[a-f0-9]{64}$/.test(item.transportFingerprint) || !/^apexnodes-desktop-[a-f0-9-]{36}$/.test(item.id)))) ||
        (metadata.legacySettled !== undefined && (!Array.isArray(metadata.legacySettled) || metadata.legacySettled.some(item =>
          !validScope(item.scope) || !/^[a-f0-9]{64}$/.test(item.transportFingerprint) ||
          !Number.isSafeInteger(item.revision) || item.revision <= 0 || item.revision > metadata.revision ||
          typeof item.provider !== 'string' || !item.provider || typeof item.model !== 'string' || !item.model)))) {
        throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
      }

      const result = operation(metadata)
      const staging = `${this.file}.${nonce}.tmp`

      try {
        fs.writeFileSync(staging, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 })
        const handle = fs.openSync(staging, 'r')

        try {fs.fsyncSync(handle)} finally {fs.closeSync(handle)}
        fs.renameSync(staging, this.file)

        if (!fs.existsSync(`${this.file}.initialized`)) {
          fs.writeFileSync(`${this.file}.initialized`, authority, { flag: 'wx', mode: 0o600 })
        }

        syncDirectory(path.dirname(this.file))
      } finally {fs.rmSync(staging, { force: true })}

      return result
    } finally {
      fs.closeSync(descriptor)

      if (JSON.parse(readOwnedFile(lock)).nonce === nonce) {fs.unlinkSync(lock)}
    }
  }

  reserve(scope: ModelMutationScope, targetId: string | null, legacyOwnedPid?: number, transportFingerprint?: string) {
    return this.locked(metadata => {
      if (!validScope(scope) || (targetId !== null && !INSTALLATION_ID_RE.test(targetId)) || metadata.revision === Number.MAX_SAFE_INTEGER) {
        throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
      }

      const pending = { id: crypto.randomUUID(), scope: { ...scope }, targetId, revision: ++metadata.revision,
        ...(transportFingerprint ? { transportFingerprint } : {}),
        ...(legacyOwnedPid ? { legacyOwnedPid } : {}) }

      metadata.pending.push(pending)

      return { ...pending, authority: metadata.authority }
    })
  }

  nextProvisionRevision(): number {
    return this.locked(metadata => {
      if (metadata.revision === Number.MAX_SAFE_INTEGER) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')}

      return ++metadata.revision
    })
  }

  pending(): PendingMutation[] {return this.locked(metadata => metadata.pending.map(item => ({ ...item, scope: { ...item.scope } })))}
  settle(ids: string[], legacy?: LegacySettlement): void {
    this.locked(metadata => {
      metadata.pending = metadata.pending.filter(item => !ids.includes(item.id))

      if (legacy) {
        metadata.legacySettled = [...(metadata.legacySettled || []).filter(item =>
          item.transportFingerprint !== legacy.transportFingerprint || item.scope.profile !== legacy.scope.profile ||
          item.scope.connectionId !== legacy.scope.connectionId), legacy]
      }
    })
  }
  legacySettled(target: ResolvedModelTarget): boolean {
    return this.locked(metadata => Boolean(metadata.legacySettled?.some(item =>
      item.transportFingerprint === legacyTransportFingerprint(target) && item.scope.profile === target.scope.profile &&
      item.scope.connectionId === target.scope.connectionId)))
  }
  managedEndpointId(): string {return this.locked(metadata => `apexnodes-desktop-${metadata.authority}`)}
  ownsLegacyEndpoint(target: ResolvedModelTarget, id: string): boolean {
    return this.locked(metadata => Boolean(metadata.ownedLegacyEndpoints?.some(item => item.id === id &&
      item.transportFingerprint === legacyTransportFingerprint(target) && item.scope.connectionId === target.scope.connectionId &&
      item.scope.profile === target.scope.profile)))
  }
  ownLegacyEndpoint(target: ResolvedModelTarget, id: string): void {
    this.locked(metadata => {
      metadata.ownedLegacyEndpoints = [...(metadata.ownedLegacyEndpoints || []).filter(item =>
        item.id !== id || item.scope.connectionId !== target.scope.connectionId || item.scope.profile !== target.scope.profile),
      { id, scope: { ...target.scope }, transportFingerprint: legacyTransportFingerprint(target) }]
    })
  }
  credentialRecovery(): boolean {return this.locked(metadata => metadata.credentialRecovery === true)}
  markCredentialRecovery(required: boolean): void {this.locked(metadata => {metadata.credentialRecovery = required})}
  beginCredentialMutation(): () => void {
    const previous = this.locked(metadata => {
      const previous = metadata.credentialRecovery === true
      metadata.credentialRecovery = true

      return previous
    })

    return () => this.markCredentialRecovery(previous)
  }
}

/** A minted key has already replaced the cloud key even when local persistence fails. */
export function commitRotatedManagedCredential(write: () => number, recordFailure: () => void): number {
  try {return write()} catch {
    try {recordFailure()} catch { /* The in-memory recovery flag is still set by Native. */ }
    throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
  }
}

export interface ResolvedModelTarget {
  scope: ModelMutationScope
  /** Actual descriptor endpoint, kept in memory only; UUID alone cannot merge hosts. */
  transportIdentity: string
  targetId: string | null
  /** Digest of captured authentication/transport facts; no secret plaintext is persisted. */
  transportAuthIdentity?: string
  legacyManagedBinding?: LegacyManagedBinding
  localRuntime?: boolean
  /** Set only on an authenticated dashboard spawned by this Native process. */
  legacyOwnedPid?: number
  runtimeProfile?: string | null
  assertCurrent?: () => void
  request: (path: string, body: unknown, headers: Record<string, string>, method?: string) => Promise<any>
}

export function legacyTransportFingerprint(target: ResolvedModelTarget): string {
  const url = new URL(target.transportIdentity)
  // HTTP ignores fragments. Query/userinfo can select a different proxy tenant,
  // so they participate in the digest without ever being persisted as plaintext.
  url.hash = ''

  return crypto.createHash('sha256').update(JSON.stringify([
    url.toString(), target.runtimeProfile || target.scope.profile || 'default', target.transportAuthIdentity || ''
  ])).digest('hex')
}

export function modelMutationHeaders(receipt: { authority: string; revision: number; targetId: string | null }) {
  return receipt.targetId ? {
    'X-Apex-Model-Authority': receipt.authority,
    'X-Apex-Model-Revision': String(receipt.revision),
    'X-Apex-Model-Target': receipt.targetId
  } : {}
}

export function modelMutationCapability(value: unknown): string {
  const result = value as { version?: unknown; target_id?: unknown }

  if (result?.version !== 1 || typeof result.target_id !== 'string' || !INSTALLATION_ID_RE.test(result.target_id)) {
    throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
  }

  return result.target_id
}

export function isModelConfigurationMutation(request: { path?: string; method?: string }): boolean {
  const pathname = new URL(String(request?.path || ''), 'http://model.invalid').pathname
  const method = String(request?.method || 'GET').toUpperCase()

  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
    (['/api/model/set', '/api/model/moa', '/api/config', '/api/config/raw'].includes(pathname) ||
      (pathname === '/api/env' && ['PUT', 'DELETE'].includes(method)) ||
      (method === 'PUT' && /^\/api\/tools\/toolsets\/[^/]+\/(model|provider|env)$/.test(pathname)) ||
      (pathname.startsWith('/api/providers/custom-endpoints') && pathname !== '/api/providers/custom-endpoints/validate'))
}

/** A released model-set pricing prompt ends before starting its writer. */
export function modelMutationConfirmation(route: string, body: any, result: any): boolean {
  return new URL(route, 'http://mutation.invalid').pathname === '/api/model/set' && result?.ok === false &&
    result.confirm_required === true && result.scope === body?.scope &&
    typeof result.provider === 'string' && result.provider === body?.provider && Boolean(result.provider) &&
    typeof result.model === 'string' && result.model === body?.model && Boolean(result.model) &&
    typeof result.confirm_message === 'string' && Boolean(result.confirm_message)
}

/** Precisely reviewed no-write exits remain actionable without a commit claim. */
export function modelMutationNoWriteResult(route: string, body: any, result: any): boolean {
  if (modelMutationConfirmation(route, body, result)) {return true}
  const matched = new URL(route, 'http://mutation.invalid').pathname.match(/^\/api\/tools\/toolsets\/([^/]+)\/env$/)
  const env = body?.env

  if (!matched || !env || typeof env !== 'object' || Array.isArray(env) || result?.ok !== true ||
    result.name !== decodeURIComponent(matched[1]) || !Array.isArray(result.saved) || result.saved.length ||
    !Array.isArray(result.skipped) || !result.is_set || typeof result.is_set !== 'object') {return false}

  const keys = Object.keys(env).sort()

  return Object.values(env).every(value => typeof value === 'string' && !value.trim()) &&
    Object.values(result.is_set).every(value => typeof value === 'boolean') &&
    JSON.stringify([...result.skipped].sort()) === JSON.stringify(keys)
}

/** Released routes return these shapes only after their synchronous writer finishes. */
export function legacyModelMutationSettled(route: string, body: any, result: any): boolean {
  const pathname = new URL(route, 'http://mutation.invalid').pathname

  if (pathname === '/api/model/set') {
    return result?.ok === true && result.scope === body?.scope &&
      typeof result.provider === 'string' && Boolean(result.provider) &&
      typeof result.model === 'string' && Boolean(result.model)
  }

  if (['/api/model/moa', '/api/config', '/api/config/raw', '/api/env'].includes(pathname) ||
    /^\/api\/tools\/toolsets\/[^/]+\/(model|provider|env)$/.test(pathname)) {return result?.ok === true}

  if (pathname.endsWith('/activate')) {
    return result?.ok === true && typeof result.provider === 'string' && typeof result.model === 'string'
  }

  if (pathname.startsWith('/api/providers/custom-endpoints')) {
    return Array.isArray(result?.endpoints) && typeof result.current?.provider === 'string' && typeof result.current?.model === 'string'
  }

  return false
}

/** Owner intent starts before login/revoke awaits; token sliding does not change it. */
export class ManagedAuthIntent {
  private epoch = 0
  begin(): () => boolean {
    const epoch = ++this.epoch

    return () => epoch === this.epoch
  }
  capture(): () => boolean {
    const epoch = this.epoch

    return () => epoch === this.epoch
  }
  cancel(): void {this.epoch++}
}

export class ManagedModelReceiptRegistry {
  private receipts = new Map<string, { target: ResolvedModelTarget; isCurrent: () => boolean; assignment: ManagedModelAssignment; result: unknown }>()

  issue(target: ResolvedModelTarget, isCurrent: () => boolean, assignment: ManagedModelAssignment, result: unknown): string {
    if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

    const id = crypto.randomUUID()
    this.receipts.set(id, { target, isCurrent, assignment: { ...assignment }, result })

    // Receipts are idempotent acknowledgements, not durable credentials.
    if (this.receipts.size > 100) {this.receipts.delete(this.receipts.keys().next().value)}

    return id
  }

  acknowledge(id: string, scope: ModelMutationScope, assignment: ManagedModelAssignment) {
    const receipt = this.receipts.get(id)
    receipt?.target.assertCurrent?.()

    if (!receipt?.isCurrent() || receipt.target.scope.connectionId !== scope.connectionId ||
      receipt.target.scope.profile !== scope.profile ||
      ['scope', 'provider', 'model', 'base_url', 'api_key'].some(key => receipt.assignment[key] !== assignment[key])) {
      throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')
    }

    return receipt
  }
}

export interface ManagedModelAssignment {
  scope: string
  provider: string
  model: string
  base_url: string
  api_key: string
}

/** Rotation is allowed only after all older writes can be superseded safely. */
export async function prepareManagedModelMutation(args: {
  coordinator: DesktopModelMutationCoordinator
  scope: ModelMutationScope
  isCurrent: () => boolean
  requiresRevision: boolean
  managedBaseUrl?: string
}): Promise<ResolvedModelTarget> {
  const target = await args.coordinator.resolveTarget(args.scope)

  if (!args.isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
  target.assertCurrent?.()

  await args.coordinator.fence(args.isCurrent)

  if (!args.isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
  target.assertCurrent?.()

  if (!target.targetId && args.requiresRevision && !target.legacyOwnedPid && !args.coordinator.legacySafe(target)) {
    throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)
  }

  if (!target.targetId && args.managedBaseUrl) {
    target.legacyManagedBinding = await prepareLegacyManagedBinding(args.coordinator, target, args.managedBaseUrl)

    if (!args.isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
    target.assertCurrent?.()
  }

  return target
}

/** Native success includes the actual durable Runtime write, before any renderer ACK. */
export async function completeManagedModelAssignment(args: {
  coordinator: DesktopModelMutationCoordinator
  receipts: ManagedModelReceiptRegistry
  target: ResolvedModelTarget
  isCurrent: () => boolean
  assignment: ManagedModelAssignment
  syncLocal: () => void
  finalize: () => void
}) {
  await args.coordinator.fence(args.isCurrent)

  if (!args.isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
  args.target.assertCurrent?.()

  const applied = args.target.legacyManagedBinding
    ? await applyLegacyManagedBinding({ coordinator: args.coordinator, target: args.target, isCurrent: args.isCurrent,
      assignment: args.assignment, binding: args.target.legacyManagedBinding })
    : await args.coordinator.run(args.target, args.isCurrent,
      headers => args.target.request('/api/model/set', args.assignment, headers),
      result => legacyModelMutationSettled('/api/model/set', args.assignment, result))

  if (applied?.ok !== true || typeof applied.provider !== 'string' || !applied.provider ||
    typeof applied.model !== 'string' || !applied.model || typeof applied.base_url !== 'string') {
    throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
  }

  if (!args.isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
  args.target.assertCurrent?.()
  args.syncLocal()

  const assignment = { ...args.assignment, provider: applied.provider, model: applied.model, base_url: applied.base_url }
  args.finalize()
  const modelReceipt = args.receipts.issue(args.target, args.isCurrent, assignment, applied)

  return { modelReceipt, modelAssignment: assignment, applied }
}

export class DesktopModelMutationCoordinator {
  private queues = new Map<string, Promise<unknown>>()

  constructor(private metadata: ModelMutationMetadataStore, private resolve: (scope: ModelMutationScope) => Promise<ResolvedModelTarget>) {}

  async resolveTarget(scope: ModelMutationScope) {return this.resolve({ ...scope })}
  legacySafe(target: ResolvedModelTarget): boolean {return this.metadata.legacySettled(target)}
  managedEndpointId(): string {return this.metadata.managedEndpointId()}
  ownsLegacyEndpoint(target: ResolvedModelTarget, id: string): boolean {return this.metadata.ownsLegacyEndpoint(target, id)}
  ownLegacyEndpoint(target: ResolvedModelTarget, id: string): void {this.metadata.ownLegacyEndpoint(target, id)}

  async run<T>(target: ResolvedModelTarget, isCurrent: () => boolean, operation: (headers: Record<string, string>) => Promise<T>,
    legacySettled: (result: T) => boolean = () => false, noWriteConfirmation: (result: T) => boolean = () => false): Promise<T> {
    if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

    const key = `${target.transportIdentity}\0${target.targetId || JSON.stringify(target.scope)}`
    const previous = this.queues.get(key)

    const pending = (previous || Promise.resolve()).catch(() => undefined).then(async () => {
      if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
      target.assertCurrent?.()

      if (!target.targetId && this.metadata.pending().some(item =>
        (item.scope.connectionId === target.scope.connectionId && item.scope.profile === target.scope.profile) ||
        item.transportFingerprint === legacyTransportFingerprint(target))) {
        await this.fence(isCurrent)

        if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
        target.assertCurrent?.()
      }

      const receipt = this.metadata.reserve(target.scope, target.targetId, target.legacyOwnedPid,
        legacyTransportFingerprint(target))

      const result = await operation(modelMutationHeaders(receipt))

      if (noWriteConfirmation(result)) {
        // Legacy's known pricing response proves no worker was started. V1
        // deliberately omits a commit ACK here, so retain its pending fence.
        if (!target.targetId) {this.metadata.settle([receipt.id])}

        if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

        return result
      }

      if (target.targetId) {
        const acknowledgement = (result as { model_mutation?: { target_id?: unknown; revision?: unknown } })?.model_mutation

        if (acknowledgement?.target_id !== target.targetId || acknowledgement.revision !== receipt.revision) {
          throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)
        }
      } else if (!legacySettled(result)) {throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE', target.localRuntime)}

      // Only a commit acknowledgement settles a tagged worker. A malformed
      // success, throw or timeout retains the captured target across restarts.
      const completed = result as { ok?: boolean; provider?: string; model?: string }

      const legacy = !target.targetId && completed.ok === true && completed.provider && completed.model
        ? { scope: target.scope, transportFingerprint: legacyTransportFingerprint(target), revision: receipt.revision,
          provider: completed.provider, model: completed.model }
        : undefined

      this.metadata.settle([receipt.id], legacy)

      if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

      return result
    })

    this.queues.set(key, pending)
    void pending.finally(() => {if (this.queues.get(key) === pending) {this.queues.delete(key)}}).catch(() => undefined)

    return pending
  }

  async fence(isCurrent: () => boolean): Promise<void> {
    const outstanding = this.metadata.pending()

    for (const item of outstanding) {
      if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

      if (item.legacyOwnedPid) {
        // Actual owned-process exit settles both legacy and tagged workers;
        // an HTTP disconnect, new healthy process or reused live PID cannot.
        try {process.kill(item.legacyOwnedPid, 0)} catch (error: any) {
          if (error?.code === 'ESRCH') {
            this.metadata.settle([item.id])

            continue
          }
        }
      }

      if (!item.targetId) {
        throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', Boolean(item.legacyOwnedPid))
      }

      const target = await this.resolve(item.scope)

      if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

      if (!target.targetId || target.targetId !== item.targetId ||
        (item.transportFingerprint && item.transportFingerprint !== legacyTransportFingerprint(target))) {throw new ModelMutationError('MODEL_RUNTIME_UPDATE_REQUIRED', target.localRuntime)}

      const receipt = this.metadata.reserve(item.scope, target.targetId, target.legacyOwnedPid, legacyTransportFingerprint(target))
      const result = await target.request('/api/model/mutation/fence', {}, modelMutationHeaders(receipt))

      if (result?.ok !== true || result.revision !== receipt.revision || result.target_id !== target.targetId) {
        throw new ModelMutationError('MODEL_RUNTIME_UNAVAILABLE')
      }

      if (!isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}

      this.metadata.settle([item.id, receipt.id])
    }
  }
}
