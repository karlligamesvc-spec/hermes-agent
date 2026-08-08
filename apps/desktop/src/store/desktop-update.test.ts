// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateCheck, DesktopShellUpdateState } from '@/global'

import {
  $desktopUpdateProgress,
  applyDesktopUpdates,
  dismissDesktopUpdateError,
  resumeDesktopUpdatePlan
} from './desktop-update'
import { $runtimeUpdateCheck } from './runtime-update'
import { $shellUpdate } from './shell-update'

const RUNTIME_UPDATE: DesktopRuntimeUpdateCheck = {
  current: { key: 'old', version: 'v2026.7.1' },
  latest: { compatibilityNotes: null, key: 'new', version: 'v2026.8.8' },
  ok: true,
  updateAvailable: true
}

const SHELL_UPDATE: DesktopShellUpdateState = {
  error: null,
  percent: 100,
  phase: 'downloaded',
  releaseNotes: null,
  version: '0.18.0'
}

beforeEach(() => {
  dismissDesktopUpdateError()
  $runtimeUpdateCheck.set(null)
  $shellUpdate.set(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('desktop update orchestration', () => {
  it('applies a ready runtime before the ready shell and uses the shell restart once', async () => {
    const order: string[] = []
    const reload = vi.fn()

    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    $shellUpdate.set(SHELL_UPDATE)
    window.hermesDesktop = {
      runtime: {
        applyUpdate: vi.fn(async () => {
          order.push('runtime')

          return { applied: true, ok: true, reloadRequired: true }
        })
      },
      shellUpdate: {
        install: vi.fn(async () => {
          order.push('shell')

          return { ok: true }
        })
      }
    } as unknown as typeof window.hermesDesktop

    await applyDesktopUpdates({ reload })

    expect(order).toEqual(['runtime', 'shell'])
    expect(reload).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get().currentStage).toBe('restart')
  })

  it('persists a continuation before installing a shell required by the runtime', async () => {
    const order: string[] = []

    $runtimeUpdateCheck.set({
      ...RUNTIME_UPDATE,
      desktopUpgradeRequired: { currentDesktopVersion: '0.17.12', minDesktopVersion: '0.18.0' },
      updateAvailable: false
    })
    $shellUpdate.set(SHELL_UPDATE)
    window.hermesDesktop = {
      runtime: { applyUpdate: vi.fn() },
      shellUpdate: {
        install: vi.fn(async () => {
          order.push('install-shell')

          return { ok: true }
        })
      },
      updateCenter: {
        setRuntimeAfterShell: vi.fn(async () => {
          order.push('persist-plan')

          return { ok: true }
        })
      }
    } as unknown as typeof window.hermesDesktop

    await applyDesktopUpdates({ reload: vi.fn() })

    expect(order).toEqual(['persist-plan', 'install-shell'])
    expect(window.hermesDesktop.runtime.applyUpdate).not.toHaveBeenCalled()
  })

  it('resumes the runtime after the new shell starts, clears the plan, then renderer-reloads', async () => {
    const reload = vi.fn()
    const clearPlan = vi.fn(async () => ({ ok: true }))

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.18.0' })),
      runtime: {
        checkUpdate: vi.fn(async () => RUNTIME_UPDATE),
        applyUpdate: vi.fn(async () => ({ applied: true, ok: true, reloadRequired: true }))
      },
      updateCenter: {
        clearPlan,
        getPlan: vi.fn(async () => ({
          kind: 'runtime-after-shell',
          requestedAt: new Date().toISOString(),
          schemaVersion: 1,
          targetRuntimeVersion: 'v2026.8.8',
          targetShellVersion: '0.18.0'
        }))
      }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload })

    expect(window.hermesDesktop.runtime.applyUpdate).toHaveBeenCalledTimes(1)
    expect(clearPlan).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('surfaces a native shell hand-off failure that arrives after install IPC returns', async () => {
    $shellUpdate.set(SHELL_UPDATE)
    window.hermesDesktop = {
      shellUpdate: {
        install: vi.fn(async () => ({ ok: true }))
      }
    } as unknown as typeof window.hermesDesktop

    await applyDesktopUpdates({ reload: vi.fn() })
    $shellUpdate.set({ ...SHELL_UPDATE, error: 'native install failed', phase: 'error' })

    expect($desktopUpdateProgress.get()).toMatchObject({
      active: false,
      currentStage: null,
      error: 'native install failed'
    })
  })

  it('does not silently replace a frozen runtime target after the shell restart', async () => {
    const applyUpdate = vi.fn()

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.18.0' })),
      runtime: {
        checkUpdate: vi.fn(async () => ({
          ...RUNTIME_UPDATE,
          latest: { ...RUNTIME_UPDATE.latest, version: 'v2026.8.9' }
        })),
        applyUpdate
      },
      updateCenter: {
        clearPlan: vi.fn(async () => ({ ok: true })),
        getPlan: vi.fn(async () => ({
          kind: 'runtime-after-shell',
          requestedAt: new Date().toISOString(),
          schemaVersion: 1,
          targetRuntimeVersion: 'v2026.8.8',
          targetShellVersion: '0.18.0'
        }))
      }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload: vi.fn() })

    expect(applyUpdate).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get().error).toBe('runtime_target_changed')
  })
})
