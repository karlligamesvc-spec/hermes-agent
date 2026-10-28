import { expect, test, vi } from 'vitest'

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
  ).resolves.toEqual({ ...deferred, reason: 'active_work', holders: null })
})

test('hc-1094: a busy apply says what it waits for, names the holders, and logs it', async () => {
  const log = vi.fn()
  const holders = { 1347: { name: 'python3.11', ppid: 1, exe: '/e/venv/bin/python', argv: [], created: 7.5, kind: 'leftover_gateway', endable: true } }
  const busy = Object.assign(new RuntimeUpdateBusy('Waiting for engine workers: 1347', 'engine_holders'), { idleProof: { holders } })

  await expect(
    preflightApply(
      PIN,
      async () => {
        throw busy
      },
      log
    )
  ).resolves.toEqual({
    ok: true,
    applied: false,
    deferred: true,
    latest: { version: 'v2026.10.17', key: 'target-key' },
    reason: 'engine_holders',
    holders: [{ pid: 1347, kind: 'leftover_gateway', name: 'python3.11', created: 7.5, endable: true }]
  })
  expect(log).toHaveBeenCalledExactlyOnceWith(
    '[runtime-update] apply deferred (version=v2026.10.17): engine_holders: Waiting for engine workers: 1347 [1347 python3.11 (/e/venv/bin/python) leftover_gateway endable]'
  )
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
