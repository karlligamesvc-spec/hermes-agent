import { expect, test } from 'vitest'

import { deferredRuntimeApply, preflightApply, RuntimeUpdateBusy, runtimeUpdateBusyReason } from './runtime-update-busy'

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

test.each([
  ['an explicit reason', new RuntimeUpdateBusy('Waiting for engine workers: 7', 'engine_holders'), 'engine_holders'],
  ['the default busy error', new RuntimeUpdateBusy(), 'active_work'],
  ['an unknown reason', { code: 'runtime_update_busy', reason: 'later' }, 'active_work'],
  ['a plain failure', new Error('identity probe failed'), 'active_work'],
  ['nothing', null, 'active_work']
])('runtimeUpdateBusyReason reads %s (hc-1030)', (_label, error, reason) => {
  expect(runtimeUpdateBusyReason(error)).toBe(reason)
})

test('any other preflight failure still fails the apply', async () => {
  await expect(
    preflightApply(PIN, async () => {
      throw new Error('identity probe failed')
    })
  ).rejects.toThrow('identity probe failed')
})
