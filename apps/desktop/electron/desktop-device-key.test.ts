import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { test } from 'vitest'

import {
  provisionDeviceBody,
  provisionKeyRevokeUrl,
  requireRevokedDeviceKey,
  revokeDeviceBody,
  signOutManagedDevice
} from './desktop-device-key'

const DEVICE_ID = '11111111-1111-4111-8111-111111111111'

test('provision body carries one canonical stable installation UUID', () => {
  assert.deepEqual(provisionDeviceBody(DEVICE_ID.toUpperCase()), { device_instance_id: DEVICE_ID })
  assert.throws(() => provisionDeviceBody('not-a-device'))
})

test('logout sends only a SHA-256 proof of the held legacy key', () => {
  const rawKey = 'sk-local-only-test-value'
  const body = revokeDeviceBody(DEVICE_ID, rawKey)

  assert.equal(body.device_instance_id, DEVICE_ID)
  assert.equal(body.legacy_key_hash, crypto.createHash('sha256').update(rawKey).digest('hex'))
  assert.equal(JSON.stringify(body).includes(rawKey), false)
  assert.throws(() => revokeDeviceBody(DEVICE_ID, ''))
})

test('revoke URL stays under the provision-key endpoint', () => {
  assert.equal(
    provisionKeyRevokeUrl('https://api.apex-nodes.com/api/v1/desktop/provision-key/'),
    'https://api.apex-nodes.com/api/v1/desktop/provision-key/revoke'
  )
})

test('logout accepts only an explicit server-side revocation proof', () => {
  assert.doesNotThrow(() => requireRevokedDeviceKey({ revoked: true }))
  assert.throws(() => requireRevokedDeviceKey({ revoked: false }))
  assert.throws(() => requireRevokedDeviceKey({}))
  assert.throws(() => requireRevokedDeviceKey(null))
})

test('managed logout revokes before clearing the local credential', async () => {
  const calls: string[] = []

  const result = await signOutManagedDevice({
    accessToken: 'login-token',
    clearCredential: () => calls.push('clear'),
    deviceInstanceId: DEVICE_ID,
    envKey: '',
    managedKey: 'stored-relay-key',
    revoke: async body => {
      assert.equal(body.device_instance_id, DEVICE_ID)
      assert.equal(JSON.stringify(body).includes('stored-relay-key'), false)
      calls.push('revoke')
    }
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, ['revoke', 'clear'])
})

test('managed logout fails closed when revoke cannot be proven', async () => {
  for (const accessToken of [null, 'login-token']) {
    let cleared = false

    const result = await signOutManagedDevice({
      accessToken,
      clearCredential: () => {
        cleared = true
      },
      deviceInstanceId: DEVICE_ID,
      envKey: '',
      managedKey: 'stored-relay-key',
      revoke: async () => {
        throw new Error('offline')
      }
    })

    assert.equal(result.ok, false)
    assert.equal(cleared, false)
  }
})

test('out-of-band and already signed-out installs clear locally without server revoke', async () => {
  for (const state of [
    { envKey: 'operator-key', managedKey: 'stored-relay-key' },
    { envKey: '', managedKey: null }
  ]) {
    let revokeCalls = 0
    let clearCalls = 0

    const result = await signOutManagedDevice({
      accessToken: null,
      clearCredential: () => {
        clearCalls += 1
      },
      deviceInstanceId: DEVICE_ID,
      ...state,
      revoke: async () => {
        revokeCalls += 1
      }
    })

    assert.deepEqual(result, { ok: true })
    assert.equal(revokeCalls, 0)
    assert.equal(clearCalls, 1)
  }
})
