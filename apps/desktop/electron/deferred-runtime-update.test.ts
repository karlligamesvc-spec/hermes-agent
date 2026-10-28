import { afterEach, expect, test, vi } from 'vitest'

import { createDeferredRuntimeUpdate, createPackagedEngineDeferral } from './deferred-runtime-update'
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

function packagedDeferral(results: { reason?: 'busy' | 'upgrade-failed'; status: 'current' | 'installed' | 'preserved' }[]) {
  const order: string[] = []
  const log = vi.fn()

  const deferral = createPackagedEngineDeferral({
    preflight: async () => void order.push('preflight'),
    track: async run => {
      order.push('track:start')

      try {
        return await run()
      } finally {
        order.push('track:end')
      }
    },
    reinstall: async () => {
      order.push('reinstall')

      return { ...results.shift()!, runtimeCommit: 'target' }
    },
    clearPin: () => void order.push('clear-pin'),
    activated: () => void order.push('activated'),
    log,
    retryMs: 100
  })

  return { deferral, log, order }
}

test('only a busy install with a usable engine is reported as deferred and retried', () => {
  const { deferral } = packagedDeferral([])

  expect(deferral.deferIfBusy(new RuntimeUpdateBusy(), () => true)).toBe(true)
  expect(deferral.isDeferred()).toBe(true)
  deferral.settle()
  expect(deferral.isDeferred()).toBe(false)
  expect(deferral.deferIfBusy(new RuntimeUpdateBusy(), () => false)).toBe(false)
  expect(deferral.deferIfBusy(new Error('checksum mismatch'), () => true)).toBe(false)
  expect(deferral.isDeferred()).toBe(false)
  deferral.dispose()
})

test('the retry installs inside the tracked start, clears the pin there, then activates', async () => {
  vi.useFakeTimers()
  const { deferral, order } = packagedDeferral([{ status: 'installed' }])

  deferral.deferIfBusy(new RuntimeUpdateBusy(), () => true)
  await vi.advanceTimersByTimeAsync(100)

  expect(order).toEqual(['preflight', 'track:start', 'reinstall', 'clear-pin', 'track:end', 'activated'])
  deferral.dispose()
})

test('a retry that is still busy keeps the pin and tries again; a failed upgrade stops for good', async () => {
  vi.useFakeTimers()

  const { deferral, log, order } = packagedDeferral([
    { reason: 'busy', status: 'preserved' },
    { reason: 'upgrade-failed', status: 'preserved' }
  ])

  deferral.deferIfBusy(new RuntimeUpdateBusy(), () => true)
  await vi.advanceTimersByTimeAsync(1_000)

  expect(order.filter(step => step === 'reinstall')).toHaveLength(2)
  expect(order).not.toContain('clear-pin')
  expect(order).not.toContain('activated')
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Bundled upgrade was not activated'))
  deferral.dispose()
})

test('hc-1094: a busy boot upgrade says what it waits for, once per change', async () => {
  vi.useFakeTimers()

  let busy: Error | null = Object.assign(new RuntimeUpdateBusy('Waiting for engine workers: 7', 'engine_holders'), {
    idleProof: { holders: { 7: { name: 'python3.11', ppid: 1, exe: '/e/venv/bin/python', argv: [], kind: 'leftover_gateway', endable: true } } }
  })

  const log = vi.fn()

  const retry = createDeferredRuntimeUpdate({
    preflight: async () => { if (busy) {throw busy} },
    install: async () => true,
    activated: vi.fn(),
    log,
    retryMs: 100
  })

  retry.schedule()
  await vi.advanceTimersByTimeAsync(350)
  expect(log.mock.calls).toEqual([
    ['[bundled-engine] deferred upgrade still waiting: engine_holders: Waiting for engine workers: 7 [7 python3.11 (/e/venv/bin/python) leftover_gateway endable]']
  ])
  busy = new RuntimeUpdateBusy()
  await vi.advanceTimersByTimeAsync(250)
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenLastCalledWith('[bundled-engine] deferred upgrade still waiting: active_work: Waiting for existing APEX work to finish.')
  retry.dispose()
})

test('hc-1094: the boot deferral names its reason in the log', () => {
  const { deferral, log } = packagedDeferral([])

  deferral.deferIfBusy(new RuntimeUpdateBusy('Waiting for Desktop activity state.', 'activity_unknown'), () => true)

  expect(log).toHaveBeenCalledExactlyOnceWith(
    '[bundled-engine] deferred while existing work finishes; keeping the current engine usable: activity_unknown: Waiting for Desktop activity state.'
  )
  deferral.dispose()
})
