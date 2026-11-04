import crypto from 'node:crypto'

import { INSTALLATION_ID_RE } from './desktop-installation'

function provisionDeviceBody(deviceInstanceId: string) {
  const normalized = String(deviceInstanceId || '').trim().toLowerCase()

  if (!INSTALLATION_ID_RE.test(normalized)) {
    throw new Error('Desktop installation ID is invalid.')
  }

  return { device_instance_id: normalized }
}

function revokeDeviceBody(deviceInstanceId: string, rawKey: string) {
  const body = provisionDeviceBody(deviceInstanceId)
  const key = String(rawKey || '').trim()

  if (!key) {
    throw new Error('Desktop relay key is missing.')
  }

  return {
    ...body,
    // Wire name retained for released clients. The raw key never leaves the
    // process; this digest cannot authenticate to relay (relay hashes raw
    // input), but lets the server prove this exact held key is already inactive
    // when the first revoke response was lost or the installation ID repaired.
    legacy_key_hash: crypto.createHash('sha256').update(key).digest('hex')
  }
}

function provisionKeyRevokeUrl(provisionKeyUrl: string) {
  const base = String(provisionKeyUrl || '').trim().replace(/\/+$/, '')

  if (!base) {
    throw new Error('Desktop provision-key URL is missing.')
  }

  return `${base}/revoke`
}

function requireRevokedDeviceKey(value: unknown) {
  if (!value || typeof value !== 'object' || (value as { revoked?: unknown }).revoked !== true) {
    throw Object.assign(new Error('Desktop relay key was not revoked.'), { code: 'DESKTOP_KEY_NOT_REVOKED' })
  }
}

/**
 * A failure for a log line: the HTTP status, never a response body that could
 * echo a credential; otherwise the error code or message with `secrets` cut out.
 */
function signOutFailureReason(error: any, secrets: Array<null | string | undefined> = []): string {
  if (Number(error?.statusCode) > 0) {
    return `HTTP ${Number(error.statusCode)}`
  }

  let reason = String(error?.code || error?.message || error || 'error')

  for (const secret of secrets.map(value => String(value || '').trim()).filter(Boolean)) {
    reason = reason.split(secret).join('…')
  }

  return reason.slice(0, 120)
}

/** The desktop.log line for a sign-out that did not finish; `timing` is signOutTiming's. */
function signOutFailureLine(reason: string, timing = ''): string {
  return `[managed] sign-out failed (${reason}); the local credential stays so it can be retried${timing}`
}

/** The parts of a sign-out the window waits for, in their order (hc-1142). */
const SIGN_OUT_STAGES = ['fence', 'capabilities', 'revoke', 'clear', 'clean-up'] as const

type SignOutStage = (typeof SIGN_OUT_STAGES)[number]

/** `; took <total> ms: <stage> <ms>, …`, the stages that ran; `revoke` is the request alone, without the capabilities read. */
function signOutTiming(spent: Partial<Record<SignOutStage, number>>, total: number): string {
  const own = { ...spent, revoke: spent.revoke === undefined ? undefined : spent.revoke - (spent.capabilities ?? 0) }
  const parts = SIGN_OUT_STAGES.filter(stage => own[stage] !== undefined).map(stage => `${stage} ${own[stage]}`)

  return `; took ${total} ms${parts.length ? `: ${parts.join(', ')}` : ''}`
}

type RevokeBody = { device_instance_id: string; legacy_key_hash?: string }

/** Times one part of the revoke from inside it, e.g. the capabilities read. */
type TimeStage = <T>(stage: 'capabilities', work: Promise<T>) => Promise<T>

interface SignOutManagedDeviceInput {
  accessToken: string | null
  clearCredential: () => void
  deviceInstanceId: string
  envKey: string
  managedKey: string | null
  revoke: (body: RevokeBody, stage: TimeStage) => Promise<void>
  isCurrent?: () => boolean
  prepare?: () => Promise<void>
  /** hc-1114: one desktop.log line per sign-out, whatever the outcome; never the key or the login token. */
  log?: (line: string) => void
  /** hc-1114: once the server revoked the key and the credential is gone (apex-sign-out.ts); returns the log detail. */
  afterClear?: () => string
  /** hc-1142: the clock the stages are timed with (Date.now). */
  now?: () => number
}

/**
 * Revoke, clear, then say what happened: the line hc-1083 found missing from
 * desktop.log. hc-1142: the same line says how long each stage took, and a
 * failure hands the renderer the HTTP status, so it can say why.
 */
async function signOutManagedDevice(input: SignOutManagedDeviceInput) {
  const now = input.now ?? Date.now
  const started = now()
  const spent: Partial<Record<SignOutStage, number>> = {}
  let revoked = false
  let revokeError: any = null

  const time = <T>(stage: SignOutStage, work: () => T): T => {
    const from = now()

    const done = () => {spent[stage] = (spent[stage] ?? 0) + now() - from}

    let result: T

    try {
      result = work()
    } catch (error) {
      done()
      throw error
    }

    if (result instanceof Promise) {return result.finally(done) as T}

    done()

    return result
  }

  const result = await revokeThenClear({
    ...input,
    prepare: input.prepare && (() => time('fence', input.prepare!)),
    clearCredential: () => time('clear', input.clearCredential),
    revoke: async body => {
      try {
        await time('revoke', () => input.revoke(body, (stage, work) => time(stage, () => work)))
        revoked = true
      } catch (error) {
        revokeError = error
        throw error
      }
    }
  })

  if (!result.ok) {
    const reason = revokeError ? signOutFailureReason(revokeError, [input.managedKey, input.accessToken]) : result.message
    input.log?.(signOutFailureLine(reason, signOutTiming(spent, now() - started)))

    return Number(revokeError?.statusCode) > 0 ? { ...result, statusCode: Number(revokeError.statusCode) } : result
  }

  if (!revoked) {
    input.log?.((String(input.envKey || '').trim()
      ? '[managed] signed out: the stored credential is deleted; the relay key comes from APEXNODES_RELAY_KEY, so nothing was revoked'
      : '[managed] signed out: no credential was stored') + signOutTiming(spent, now() - started))

    return result
  }

  let detail = ''

  try {
    detail = time('clean-up', () => input.afterClear?.() || '')
  } catch (error) {
    detail = `local clean-up failed (${signOutFailureReason(error, [input.managedKey, input.accessToken])})`
  }

  input.log?.(`[managed] signed out: the server revoked this computer's relay key and the stored credential is deleted${detail ? `; ${detail}` : ''}${signOutTiming(spent, now() - started)}`)

  return result
}

async function revokeThenClear(input: Omit<SignOutManagedDeviceInput, 'revoke'> & { revoke: (body: RevokeBody) => Promise<void> }) {
  const managedKey = String(input.managedKey || '').trim()
  const envKey = String(input.envKey || '').trim()
  const isCurrent = input.isCurrent || (() => true)

  try {
    await input.prepare?.()
  } catch (error: any) {
    return { ok: false, message: error?.code || 'MODEL_RUNTIME_UNAVAILABLE' }
  }

  if (!isCurrent()) {return { ok: false, message: 'MODEL_MUTATION_SUPERSEDED' }}

  if ((managedKey || input.accessToken) && !envKey) {
    if (!input.accessToken) {
      return { ok: false, message: 'SIGN_OUT_REQUIRES_SIGN_IN' }
    }

    try {
      await input.revoke(managedKey ? revokeDeviceBody(input.deviceInstanceId, managedKey) : provisionDeviceBody(input.deviceInstanceId))
    } catch (error: any) {
      return { ok: false, message: error && error.message ? error.message : String(error) }
    }
  }

  // Clearing is deliberately last. A revoke/network failure must leave the
  // encrypted local credential intact so logout can be retried and the server
  // is never left with an invisible active key.
  if (!isCurrent()) {return { ok: false, message: 'MODEL_MUTATION_SUPERSEDED' }}

  try {input.clearCredential()} catch {
    return { ok: false, message: 'SIGN_OUT_CLEAR_FAILED' }
  }

  return { ok: true }
}

export {
  provisionDeviceBody,
  provisionKeyRevokeUrl,
  requireRevokedDeviceKey,
  revokeDeviceBody,
  signOutFailureLine,
  signOutFailureReason,
  signOutManagedDevice
}
