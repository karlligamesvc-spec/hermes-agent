import { afterEach, expect, test, vi } from 'vitest'

import { createDeferredRuntimeUpdate } from './deferred-runtime-update'
import { RuntimeUpdateBusy } from './runtime-update-busy'

afterEach(() => vi.useRealTimers())

test('keeps the old backend untouched while busy, then activates once without user retry', async () => {
  vi.useFakeTimers()
  let busy = true
  const install = vi.fn(async () => true)
  const activated = vi.fn()
  const retry = createDeferredRuntimeUpdate({
    preflight: async () => { if (busy) {throw new RuntimeUpdateBusy()} },
    install, activated, log: vi.fn(), retryMs: 100
  })
  retry.schedule()
  retry.schedule()
  await vi.advanceTimersByTimeAsync(300)
  expect(install).not.toHaveBeenCalled()
  expect(activated).not.toHaveBeenCalled()
  busy = false
  await vi.advanceTimersByTimeAsync(300)
  expect(install).toHaveBeenCalledTimes(1)
  expect(activated).toHaveBeenCalledTimes(1)
  retry.dispose()
})

test('rechecks a late occupancy conflict; failed verification never triggers reload or endless retries', async () => {
  vi.useFakeTimers()
  const install = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('checksum mismatch'))
  const activated = vi.fn()
  const log = vi.fn()
  const retry = createDeferredRuntimeUpdate({ preflight: async () => {}, install, activated, log, retryMs: 100 })
  retry.schedule()
  await vi.advanceTimersByTimeAsync(1000)
  expect(install).toHaveBeenCalledTimes(2)
  expect(activated).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  retry.dispose()
})

test('quitting during preflight cancels deferred activation', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const install = vi.fn(async () => true)
  const activated = vi.fn()
  const retry = createDeferredRuntimeUpdate({
    preflight: () => new Promise<void>(resolve => { release = resolve }), install, activated, log: vi.fn(), retryMs: 100
  })
  retry.schedule()
  await vi.advanceTimersByTimeAsync(100)
  retry.dispose()
  release()
  await vi.advanceTimersByTimeAsync(1000)
  expect(install).not.toHaveBeenCalled()
  expect(activated).not.toHaveBeenCalled()
})
