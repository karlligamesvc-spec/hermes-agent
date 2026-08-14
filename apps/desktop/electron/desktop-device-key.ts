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
    // Upgrade bridge for pre-hc-731 credentials. The raw key never leaves the
    // process; this digest cannot authenticate to relay (relay hashes raw input).
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
    throw new Error('Desktop relay key was not revoked.')
  }
}

interface SignOutManagedDeviceInput {
  accessToken: string | null
  clearCredential: () => void
  deviceInstanceId: string
  envKey: string
  managedKey: string | null
  revoke: (body: ReturnType<typeof revokeDeviceBody>) => Promise<void>
}

async function signOutManagedDevice(input: SignOutManagedDeviceInput) {
  const managedKey = String(input.managedKey || '').trim()
  const envKey = String(input.envKey || '').trim()

  if (managedKey && !envKey) {
    if (!input.accessToken) {
      return { ok: false, message: 'SIGN_OUT_REQUIRES_SIGN_IN' }
    }

    try {
      await input.revoke(revokeDeviceBody(input.deviceInstanceId, managedKey))
    } catch (error: any) {
      return { ok: false, message: error && error.message ? error.message : String(error) }
    }
  }

  // Clearing is deliberately last. A revoke/network failure must leave the
  // encrypted local credential intact so logout can be retried and the server
  // is never left with an invisible active key.
  input.clearCredential()

  return { ok: true }
}

export {
  provisionDeviceBody,
  provisionKeyRevokeUrl,
  requireRevokedDeviceKey,
  revokeDeviceBody,
  signOutManagedDevice
}
