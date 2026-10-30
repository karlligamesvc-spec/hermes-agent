import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { describe, test } from 'vitest'

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

test('logout sends only a SHA-256 proof of the exact held key', () => {
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

test('an existing account with no readable relay key still publishes its device logout before local clear', async () => {
  const calls: unknown[] = []

  const result = await signOutManagedDevice({ accessToken: 'hc903-fixture-token', managedKey: null, envKey: '',
    deviceInstanceId: DEVICE_ID, clearCredential: () => {calls.push('clear')},
    revoke: async body => {calls.push(body)} })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [{ device_instance_id: DEVICE_ID }, 'clear'])
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

test('managed logout can retry the same proof after a lost revoke response', async () => {
  const bodies: unknown[] = []
  let cleared = false
  let attempts = 0

  const input = {
    accessToken: 'login-token',
    clearCredential: () => {
      cleared = true
    },
    deviceInstanceId: DEVICE_ID,
    envKey: '',
    managedKey: 'stored-relay-key',
    revoke: async body => {
      bodies.push(body)
      attempts += 1

      if (attempts === 1) {
        throw new Error('response lost after server revoke')
      }
    }
  }

  assert.deepEqual(await signOutManagedDevice(input), {
    ok: false,
    message: 'response lost after server revoke'
  })
  assert.equal(cleared, false)
  assert.deepEqual(await signOutManagedDevice(input), { ok: true })
  assert.equal(cleared, true)
  assert.deepEqual(bodies[0], bodies[1])
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

// hc-1114: every sign-out leaves one desktop.log line, and only a revoke the
// server confirmed lets the copies and the engines be cleaned up.
describe('the sign-out line and the clean-up after it (hc-1114)', () => {
  const KEY = 'sk-hc1114-held-relay-key-000000'
  const TOKEN = 'login.jwt.hc1114'

  function signOut(overrides: Record<string, unknown> = {}) {
    const calls: string[] = []
    const log: string[] = []

    const run = signOutManagedDevice({
      accessToken: TOKEN,
      clearCredential: () => calls.push('clear'),
      deviceInstanceId: DEVICE_ID,
      envKey: '',
      managedKey: KEY,
      revoke: async () => {
        calls.push('revoke')
      },
      log: line => log.push(line),
      afterClear: () => {
        calls.push('afterClear')

        return 'relay key removed from 3 local file(s); engines still on it restart once idle'
      },
      ...overrides
    })

    return { calls, log, run }
  }

  const secretFree = (lines: string[]) => lines.every(line => !line.includes(KEY) && !line.includes(TOKEN))

  test('revoked: clean-up runs after the credential is gone, and the line says both', async () => {
    const { calls, log, run } = signOut()

    assert.deepEqual(await run, { ok: true })
    assert.deepEqual(calls, ['revoke', 'clear', 'afterClear'])
    assert.deepEqual(log, [
      "[managed] signed out: the server revoked this computer's relay key and the stored credential is deleted; " +
        'relay key removed from 3 local file(s); engines still on it restart once idle'
    ])
  })

  test('a failed revoke keeps everything, logs the status code, never the body', async () => {
    const { calls, log, run } = signOut({
      revoke: async () => {
        throw Object.assign(new Error(`401: {"detail":"Token expired","key":"${KEY}"}`), { statusCode: 401 })
      }
    })

    assert.equal((await run).ok, false)
    assert.deepEqual(calls, [])
    assert.deepEqual(log, ['[managed] sign-out failed (HTTP 401); the local credential stays so it can be retried'])
  })

  test('a server answer that is not a revocation proof fails the same way', async () => {
    const { calls, log, run } = signOut({
      revoke: async () => requireRevokedDeviceKey({ revoked: false })
    })

    assert.equal((await run).ok, false)
    assert.deepEqual(calls, [])
    assert.deepEqual(log, ['[managed] sign-out failed (DESKTOP_KEY_NOT_REVOKED); the local credential stays so it can be retried'])
  })

  test.each([
    ['no login token', { accessToken: null }, 'SIGN_OUT_REQUIRES_SIGN_IN'],
    ['a newer sign-in in between', { isCurrent: () => false }, 'MODEL_MUTATION_SUPERSEDED'],
    ['the credential file cannot be removed', { clearCredential: () => { throw new Error('EPERM') } }, 'SIGN_OUT_CLEAR_FAILED']
  ])('%s: logged as a failure, no clean-up', async (_name, overrides, code) => {
    const { calls, log, run } = signOut(overrides)

    assert.equal((await run).ok, false)
    assert.equal(calls.includes('afterClear'), false)
    assert.deepEqual(log, [`[managed] sign-out failed (${code}); the local credential stays so it can be retried`])
  })

  test('an env key is not ours to revoke or scrub', async () => {
    const { calls, log, run } = signOut({ envKey: 'operator-key' })

    assert.deepEqual(await run, { ok: true })
    assert.deepEqual(calls, ['clear'])
    assert.deepEqual(log, [
      '[managed] signed out: the stored credential is deleted; the relay key comes from APEXNODES_RELAY_KEY, so nothing was revoked'
    ])
  })

  test('nothing stored: one line, no revoke, no clean-up', async () => {
    const { calls, log, run } = signOut({ accessToken: null, managedKey: null })

    assert.deepEqual(await run, { ok: true })
    assert.deepEqual(calls, ['clear'])
    assert.deepEqual(log, ['[managed] signed out: no credential was stored'])
  })

  test('a clean-up that throws does not undo a confirmed sign-out', async () => {
    const { log, run } = signOut({
      afterClear: () => {
        throw Object.assign(new Error('boom'), { code: 'EIO' })
      }
    })

    assert.deepEqual(await run, { ok: true })
    assert.equal(log.length, 1)
    assert.ok(log[0].endsWith('; local clean-up failed (EIO)'), log[0])
  })

  test('no line carries the key or the login token', async () => {
    const lines: string[] = []

    for (const overrides of [{}, { revoke: async () => {throw new Error(`echo ${KEY} ${TOKEN}`)} }, { envKey: 'x' }]) {
      const { log, run } = signOut(overrides)
      await run
      lines.push(...log)
    }

    assert.equal(lines.length, 3)
    assert.ok(secretFree(lines), lines.join('\n'))
  })
})
