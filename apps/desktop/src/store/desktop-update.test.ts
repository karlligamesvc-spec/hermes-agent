// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateCheck, DesktopShellUpdateState, DesktopUpdatePlan } from '@/global'

import {
  $desktopUpdateProgress,
  applyDesktopUpdates,
  dismissDesktopUpdateError,
  resumeDesktopUpdatePlan,
  retryDesktopUpdate
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

function updatePlan(overrides: Partial<DesktopUpdatePlan> = {}): DesktopUpdatePlan {
  const now = new Date().toISOString()

  return {
    schemaVersion: 1,
    planId: 'plan-1',
    kind: 'runtime-after-shell',
    phase: 'ready-to-restart',
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
    currentShellVersion: '0.17.14',
    targetShellVersion: '0.18.0',
    currentRuntimeKey: 'old',
    currentRuntimeVersion: 'v2026.7.1',
    targetRuntimeKey: 'new',
    targetRuntimeVersion: 'v2026.8.8',
    attempts: 0,
    lastError: null,
    ...overrides
  }
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
      },
      updateCenter: {
        setShellOnly: vi.fn(async () => {
          order.push('persist-shell-only')

          return { ok: true }
        }),
        transitionPlan: vi.fn(async () => ({ ok: true }))
      }
    } as unknown as typeof window.hermesDesktop

    await applyDesktopUpdates({ reload })

    expect(order).toEqual(['runtime', 'persist-shell-only', 'shell'])
    expect(reload).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get().currentStage).toBe('restart')
  })

  it('mirrors real runtime download bytes while the main-process apply is active', async () => {
    const controls: {
      emitProgress?: (progress: { attempt: number; phase: 'downloading'; received: number; total: number }) => void
      finishApply?: (result: { applied: true; ok: true; reloadRequired: false }) => void
    } = {}

    const applyResult = new Promise<{ applied: true; ok: true; reloadRequired: false }>(resolve => {
      controls.finishApply = resolve
    })

    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    window.hermesDesktop = {
      runtime: {
        applyUpdate: vi.fn(() => applyResult),
        onUpdateProgress: vi.fn(callback => {
          controls.emitProgress = callback

          return () => {}
        })
      }
    } as unknown as typeof window.hermesDesktop

    const applying = applyDesktopUpdates({ reload: vi.fn() })

    await vi.waitFor(() => expect(window.hermesDesktop.runtime.applyUpdate).toHaveBeenCalledTimes(1))
    controls.emitProgress?.({ attempt: 2, phase: 'downloading', received: 256, total: 1024 })

    expect($desktopUpdateProgress.get().runtimeProgress).toEqual({
      attempt: 2,
      phase: 'downloading',
      received: 256,
      total: 1024
    })

    controls.finishApply?.({ applied: true, ok: true, reloadRequired: false })
    await applying
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
        }),
        transitionPlan: vi.fn(async () => ({ ok: true }))
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
        getPlan: vi.fn(async () => updatePlan()),
        transitionPlan: vi.fn(async () => ({ ok: true }))
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
      },
      updateCenter: {
        setShellOnly: vi.fn(async () => ({ ok: true })),
        transitionPlan: vi.fn(async () => ({ ok: true }))
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
        getPlan: vi.fn(async () => updatePlan()),
        transitionPlan: vi.fn(async () => ({ ok: true }))
      }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload: vi.fn() })

    expect(applyUpdate).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get().error).toBe('runtime_target_changed')
  })

  it('reads back shell and runtime targets before clearing a shell-only plan', async () => {
    const clearPlan = vi.fn(async () => ({ ok: true }))
    const transitionPlan = vi.fn(async () => ({ ok: true }))

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.18.0' })),
      runtime: {
        getVersion: vi.fn(async () => ({
          branch: null,
          commit: null,
          key: 'new',
          ok: true,
          version: 'v2026.8.8'
        }))
      },
      updateCenter: {
        clearPlan,
        getPlan: vi.fn(async () => updatePlan({ kind: 'shell-only' })),
        transitionPlan
      }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload: vi.fn() })

    expect(transitionPlan).toHaveBeenCalledWith({ incrementAttempt: true, phase: 'resuming' })
    expect(clearPlan).toHaveBeenCalledTimes(1)
    expect($desktopUpdateProgress.get()).toMatchObject({
      active: false,
      completedStages: ['check', 'shell', 'restart'],
      currentStage: null
    })
  })

  it('keeps a shell-only plan and records failure when the running shell is not the frozen target', async () => {
    const clearPlan = vi.fn(async () => ({ ok: true }))
    const transitionPlan = vi.fn(async () => ({ ok: true }))

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.17.14' })),
      updateCenter: {
        clearPlan,
        getPlan: vi.fn(async () => updatePlan({ kind: 'shell-only' })),
        transitionPlan
      }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload: vi.fn() })

    expect(clearPlan).not.toHaveBeenCalled()
    expect(transitionPlan).toHaveBeenLastCalledWith({
      lastError: 'shell_target_not_running',
      phase: 'failed'
    })
    expect($desktopUpdateProgress.get().error).toBe('shell_target_not_running')
  })

  it('retries the frozen native shell install instead of looping on readback failure', async () => {
    const install = vi.fn(async () => ({ ok: true }))
    const transitionPlan = vi.fn(async () => ({ ok: true }))

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.17.14' })),
      shellUpdate: {
        check: vi.fn(async () => ({ ok: true, state: SHELL_UPDATE })),
        getState: vi.fn(async () => SHELL_UPDATE),
        install,
        onEvent: vi.fn(() => () => {})
      },
      updateCenter: {
        getPlan: vi.fn(async () => updatePlan({ kind: 'shell-only' })),
        transitionPlan
      }
    } as unknown as typeof window.hermesDesktop

    await retryDesktopUpdate({ reload: vi.fn() })

    expect(transitionPlan).toHaveBeenLastCalledWith({ phase: 'ready-to-restart' })
    expect(install).toHaveBeenCalledTimes(1)
    expect($desktopUpdateProgress.get()).toMatchObject({
      active: true,
      currentStage: 'restart',
      error: null
    })
  })
})
