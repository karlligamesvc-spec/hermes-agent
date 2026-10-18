import { expect, test } from 'vitest'

import { deferredRuntimeApply, preflightApply, RuntimeUpdateBusy } from './runtime-update-busy'

const PIN = { key: 'target-key', version: 'v2026.10.17' }

test('a busy preflight answers the frozen target as deferred instead of failing the apply', async () => {
  const deferred = { ok: true, applied: false, deferred: true, latest: { version: 'v2026.10.17', key: 'target-key' } }

  expect(deferredRuntimeApply(PIN)).toEqual(deferred)
  await expect(preflightApply(PIN, async () => {})).resolves.toBeNull()
  await expect(
    preflightApply(PIN, async () => {
      throw new RuntimeUpdateBusy()
    })
  ).resolves.toEqual(deferred)
})

test('any other preflight failure still fails the apply', async () => {
  await expect(
    preflightApply(PIN, async () => {
      throw new Error('identity probe failed')
    })
  ).rejects.toThrow('identity probe failed')
})
