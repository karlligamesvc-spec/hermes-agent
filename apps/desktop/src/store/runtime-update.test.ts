import { afterEach, expect, test, vi } from 'vitest'

import { derivePinFromLatest } from '../../electron/apex-runtime-latest'
import { applyRuntimeUpdateToLatest } from '../../electron/runtime-update-apply'
import type { DesktopRuntimeUpdateApply, DesktopRuntimeUpdateExpectedTarget } from '../global'

import { $runtimeUpdateApplying, applyRuntimeUpdate } from './runtime-update'

const originalBridge = window.hermesDesktop

afterEach(() => {
  window.hermesDesktop = originalBridge
  $runtimeUpdateApplying.set(false)
})

test('the runtime store carries its frozen target to the apply producer and surfaces a changed target', async () => {
  const checked = { expectedKey: 'a'.repeat(40), expectedVersion: 'v2026.10.1-fork.fixture' }
  const changed = derivePinFromLatest({ upstream_commit: 'b'.repeat(40), version: checked.expectedVersion })!
  const mutation = vi.fn(async () => ({ ok: true, applied: true }))

  const applyUpdate = vi.fn(
    async (expectedTarget?: DesktopRuntimeUpdateExpectedTarget) =>
      applyRuntimeUpdateToLatest(expectedTarget, {
        updatesAllowed: () => true,
        resolveLatest: async () => changed,
        applyResolved: mutation
      }) as Promise<DesktopRuntimeUpdateApply>
  )

  window.hermesDesktop = { runtime: { applyUpdate } } as unknown as typeof window.hermesDesktop

  await expect(applyRuntimeUpdate(checked)).rejects.toThrow('runtime_target_changed')
  expect(applyUpdate).toHaveBeenCalledWith(checked)
  expect(mutation).not.toHaveBeenCalled()
  expect($runtimeUpdateApplying.get()).toBe(false)

  await expect(applyRuntimeUpdate()).resolves.toEqual({ ok: true, applied: true })
  expect(mutation).toHaveBeenCalledOnce()
  expect($runtimeUpdateApplying.get()).toBe(false)
})
