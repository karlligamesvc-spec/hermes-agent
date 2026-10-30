// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateCheck, DesktopShellUpdateState, DesktopUpdatePlan } from '@/global'

import { clearDesktopUpdatePlan, readDesktopUpdatePlan, readPreparedDesktopUpdatePlan, transitionDesktopUpdatePlan, writeDesktopUpdatePlan } from '../../electron/desktop-update-plan'
import { createLocalBackendLifecycle } from '../../electron/local-backend-lifecycle'
import { createPackagedRuntimeGate } from '../../electron/packaged-runtime'
import { registerRuntimeVersionIpc, waitForPendingRuntimePreparation } from '../../electron/runtime-version'

import {
  $desktopUpdateProgress,
  applyDesktopUpdates,
  dismissDesktopUpdateError,
  resumeDesktopUpdatePlan,
  retryDesktopUpdate
} from './desktop-update'
import { $runtimeUpdateCheck } from './runtime-update'
import { $shellUpdate } from './shell-update'
import { $runtimeUpdateWait } from './update-wait'

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
  dismissDesktopUpdateError()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('desktop update orchestration', () => {
  it('keeps a durable target and usable UI through a busy boot, then finishes automatically after native activation', async () => {
    vi.useFakeTimers()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-update-busy-'))
    const file = path.join(home, 'plan.json')
    writeDesktopUpdatePlan(file, updatePlan())
    let busy = true
    const reload = vi.fn()
    const applyUpdate = vi.fn()
    window.hermesDesktop = {
      getVersion: async () => ({ appVersion: '0.18.0' }),
      runtime: {
        getVersion: async () => ({ ok: true, key: busy ? 'old' : 'new', treeMatchesMarker: true, updateDeferred: busy }),
        applyUpdate
      },
      updateCenter: {
        getPlan: async () => readDesktopUpdatePlan(file),
        transitionPlan: async (payload: Parameters<typeof transitionDesktopUpdatePlan>[1]) => ({ ok: true, plan: transitionDesktopUpdatePlan(file, payload) }),
        clearPlan: async () => { clearDesktopUpdatePlan(file); return { ok: true } }
      }
    } as unknown as typeof window.hermesDesktop
    try {
      await resumeDesktopUpdatePlan({ reload })
      expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null })
      expect(readDesktopUpdatePlan(file)).toMatchObject({ targetRuntimeKey: 'new', lastError: 'runtime_update_busy', phase: 'resuming' })
      expect(reload).not.toHaveBeenCalled()
      expect(applyUpdate).not.toHaveBeenCalled()
      busy = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(readDesktopUpdatePlan(file)).toBeNull()
      expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null, completedStages: ['check', 'shell', 'runtime', 'restart'] })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('runtime-only deferral persists its frozen target instead of reloading or claiming completion', async () => {
    vi.useFakeTimers()
    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    const save = vi.fn(async () => ({ ok: true }))
    const reload = vi.fn()
    window.hermesDesktop = {
      runtime: { applyUpdate: async () => ({ ok: true, applied: false, deferred: true }) },
      updateCenter: { setRuntimeAfterShell: save, transitionPlan: async () => ({ ok: true }) }
    } as unknown as typeof window.hermesDesktop
    await applyDesktopUpdates({ reload })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ targetRuntimeKey: 'new', targetShellVersion: null }))
    expect(reload).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null, completedStages: ['check'] })
  })

  it('a busy apply on the automatic resume keeps the frozen plan and finishes on the retry', async () => {
    vi.useFakeTimers()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-apply-busy-'))
    const file = path.join(home, 'plan.json')
    writeDesktopUpdatePlan(file, updatePlan())
    let activeKey = 'old'
    const reload = vi.fn()

    const applyUpdate = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, applied: false, deferred: true })
      .mockImplementationOnce(async () => {
        activeKey = 'new'

        return { ok: true, applied: true, reloadRequired: false }
      })

    window.hermesDesktop = {
      getVersion: async () => ({ appVersion: '0.18.0' }),
      runtime: {
        getVersion: async () => ({ ok: true, key: activeKey, version: 'v2026.8.8', treeMatchesMarker: true, updateDeferred: false }),
        checkUpdate: async () => RUNTIME_UPDATE,
        applyUpdate
      },
      updateCenter: {
        getPlan: async () => readDesktopUpdatePlan(file),
        transitionPlan: async (payload: Parameters<typeof transitionDesktopUpdatePlan>[1]) => ({
          ok: true,
          plan: transitionDesktopUpdatePlan(file, payload)
        }),
        clearPlan: async () => {
          clearDesktopUpdatePlan(file)

          return { ok: true }
        }
      }
    } as unknown as typeof window.hermesDesktop

    try {
      await resumeDesktopUpdatePlan({ reload, automatic: true })
      expect(applyUpdate).toHaveBeenCalledTimes(1)
      expect(readDesktopUpdatePlan(file)).toMatchObject({ targetRuntimeKey: 'new', lastError: 'runtime_update_busy', phase: 'resuming' })
      expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null })

      // The retry re-enters the same frozen plan despite its recorded attempt
      // and the once-per-plan latch the automatic resume just set.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(applyUpdate).toHaveBeenCalledTimes(2)
      expect(readDesktopUpdatePlan(file)).toBeNull()
      expect($desktopUpdateProgress.get()).toMatchObject({
        active: false,
        error: null,
        completedStages: ['check', 'shell', 'runtime', 'restart']
      })
      expect(reload).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a deferred shell install leaves the update idle instead of stuck on restart', async () => {
    $shellUpdate.set(SHELL_UPDATE)
    const install = vi.fn(async () => ({ ok: true, deferred: true }))

    window.hermesDesktop = {
      shellUpdate: { install },
      updateCenter: { setShellOnly: vi.fn(async () => ({ ok: true })), transitionPlan: vi.fn(async () => ({ ok: true })) }
    } as unknown as typeof window.hermesDesktop

    await applyDesktopUpdates({ reload: vi.fn() })

    expect(install).toHaveBeenCalledTimes(1)
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, currentStage: null, error: null })
  })

  describe('hc-1117: telling the caller the update waits, and for what', () => {
    const CHILD = { pid: 4242, kind: 'leftover_child', name: 'python3.14', created: 7.5, endable: true } as const
    const updateCenter = { setShellOnly: vi.fn(async () => ({ ok: true })), setRuntimeAfterShell: vi.fn(async () => ({ ok: true })), transitionPlan: vi.fn(async () => ({ ok: true })) }

    beforeEach(() => $runtimeUpdateWait.set(null))

    it('a deferred app install answers true, and the store holds the wait even before its event arrives', async () => {
      $shellUpdate.set(SHELL_UPDATE)
      const state = { ...SHELL_UPDATE, deferred: true, deferredReason: 'engine_holders', deferredHolders: [CHILD] }

      window.hermesDesktop = {
        shellUpdate: { install: vi.fn(async () => ({ ok: true, deferred: true, state })) },
        updateCenter
      } as unknown as typeof window.hermesDesktop

      await expect(applyDesktopUpdates({ reload: vi.fn() })).resolves.toBe(true)
      expect($shellUpdate.get()).toEqual(state)
    })

    it('an app install that goes ahead answers false', async () => {
      $shellUpdate.set(SHELL_UPDATE)
      window.hermesDesktop = { shellUpdate: { install: vi.fn(async () => ({ ok: true })) }, updateCenter } as unknown as typeof window.hermesDesktop

      await expect(applyDesktopUpdates({ reload: vi.fn() })).resolves.toBe(false)
      expect($shellUpdate.get()).toEqual(SHELL_UPDATE)
    })

    it('a shell required first answers what its install does', async () => {
      $shellUpdate.set(SHELL_UPDATE)
      $runtimeUpdateCheck.set({ ...RUNTIME_UPDATE, updateAvailable: false, desktopUpgradeRequired: { minDesktopVersion: '0.18.0', currentDesktopVersion: '0.17.14' } })
      window.hermesDesktop = { shellUpdate: { install: vi.fn(async () => ({ ok: true, deferred: true })) }, updateCenter } as unknown as typeof window.hermesDesktop

      await expect(applyDesktopUpdates({ reload: vi.fn() })).resolves.toBe(true)
    })

    it('a deferred engine switch answers true and keeps what the gate named', async () => {
      vi.useFakeTimers()
      $runtimeUpdateCheck.set(RUNTIME_UPDATE)
      window.hermesDesktop = {
        runtime: { applyUpdate: async () => ({ ok: true, applied: false, deferred: true, reason: 'engine_holders', holders: [CHILD] }) },
        updateCenter
      } as unknown as typeof window.hermesDesktop

      await expect(applyDesktopUpdates({ reload: vi.fn() })).resolves.toBe(true)
      expect($runtimeUpdateWait.get()).toEqual({ reason: 'engine_holders', holders: [CHILD] })
    })

    it('a deferred engine switch that names nothing still reads as a wait', async () => {
      vi.useFakeTimers()
      $runtimeUpdateCheck.set(RUNTIME_UPDATE)
      window.hermesDesktop = {
        runtime: { applyUpdate: async () => ({ ok: true, applied: false, deferred: true }) },
        updateCenter
      } as unknown as typeof window.hermesDesktop

      await applyDesktopUpdates({ reload: vi.fn() })
      expect($runtimeUpdateWait.get()).toEqual({ reason: 'active_work', holders: null })
    })

    it('an engine switch that goes ahead ends the wait and answers false', async () => {
      $runtimeUpdateCheck.set(RUNTIME_UPDATE)
      $runtimeUpdateWait.set({ reason: 'engine_holders', holders: [CHILD] })
      const reload = vi.fn()

      window.hermesDesktop = {
        runtime: { applyUpdate: async () => ({ ok: true, applied: true, reloadRequired: true }) },
        updateCenter
      } as unknown as typeof window.hermesDesktop

      await expect(applyDesktopUpdates({ reload })).resolves.toBe(false)
      expect($runtimeUpdateWait.get()).toBeNull()
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it('a failed update ends the wait', async () => {
      $runtimeUpdateCheck.set(RUNTIME_UPDATE)
      $runtimeUpdateWait.set({ reason: 'engine_holders', holders: [CHILD] })
      window.hermesDesktop = {
        runtime: { applyUpdate: async () => { throw new Error('bridge gone') } },
        updateCenter
      } as unknown as typeof window.hermesDesktop

      await expect(applyDesktopUpdates({ reload: vi.fn() })).rejects.toThrow('bridge gone')
      expect($runtimeUpdateWait.get()).toBeNull()
    })

    it('a failed automatic resume ends the wait', async () => {
      $runtimeUpdateWait.set({ reason: 'engine_holders', holders: [CHILD] })
      window.hermesDesktop = {
        getVersion: vi.fn(async () => { throw new Error('bridge gone') }),
        updateCenter: { ...updateCenter, getPlan: vi.fn(async () => updatePlan()) }
      } as unknown as typeof window.hermesDesktop

      await resumeDesktopUpdatePlan({ reload: vi.fn() })
      expect($runtimeUpdateWait.get()).toBeNull()
    })

    it('dismissing the update ends the wait', () => {
      $runtimeUpdateWait.set({ reason: 'gateway_busy', holders: null })
      dismissDesktopUpdateError()
      expect($runtimeUpdateWait.get()).toBeNull()
    })
  })

  it('resuming a plan whose downloaded shell is not running yet asks for that shell again', async () => {
    $shellUpdate.set(SHELL_UPDATE)
    const install = vi.fn(async () => ({ ok: true, deferred: true }))

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.17.14' })),
      shellUpdate: { install },
      updateCenter: { getPlan: vi.fn(async () => updatePlan()), transitionPlan: vi.fn(async () => ({ ok: true })) }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload: vi.fn() })

    expect(install).toHaveBeenCalledTimes(1)
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null })
  })

  it('dismissing the update state cancels a pending deferred retry', async () => {
    vi.useFakeTimers()
    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    const getPlan = vi.fn(async () => null)

    window.hermesDesktop = {
      runtime: { applyUpdate: async () => ({ ok: true, applied: false, deferred: true }) },
      updateCenter: { getPlan, setRuntimeAfterShell: async () => ({ ok: true }), transitionPlan: async () => ({ ok: true }) }
    } as unknown as typeof window.hermesDesktop

    await applyDesktopUpdates({ reload: vi.fn() })
    dismissDesktopUpdateError()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(getPlan).not.toHaveBeenCalled()
  })

  it.each([false, true])('bounds failed activation across a fresh renderer (activated=%s)', async activated => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-reload-loop-'))
    const file = path.join(home, 'plan.json')
    writeDesktopUpdatePlan(file, updatePlan())
    let activeKey = 'old'
    const applyUpdate = vi.fn(async () => ({ ok: true, applied: true, reloadRequired: true }))
    const reload = vi.fn()
    window.hermesDesktop = {
      getVersion: async () => ({ appVersion: '0.18.0' }),
      runtime: {
        getVersion: async () => ({ ok: true, key: activeKey, version: 'v2026.8.8', treeMatchesMarker: true }),
        checkUpdate: async () => RUNTIME_UPDATE,
        applyUpdate
      },
      updateCenter: {
        getPlan: async () => readDesktopUpdatePlan(file),
        transitionPlan: async (payload: Parameters<typeof transitionDesktopUpdatePlan>[1]) => ({ ok: true, plan: transitionDesktopUpdatePlan(file, payload) }),
        clearPlan: async () => { clearDesktopUpdatePlan(file);

 return { ok: true } }
      }
    } as unknown as typeof window.hermesDesktop

    try {
      vi.resetModules()
      const first = await import('./desktop-update')
      await first.resumeDesktopUpdatePlan({ automatic: true, reload })
      expect(applyUpdate).toHaveBeenCalledTimes(1)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(readDesktopUpdatePlan(file)?.attempts).toBe(1)
      activeKey = activated ? 'new' : 'old'
      // A real reload destroys every module-local latch; the disk plan survives.
      vi.resetModules()
      const next = await import('./desktop-update')
      await next.resumeDesktopUpdatePlan({ automatic: true, reload })
      expect(applyUpdate).toHaveBeenCalledTimes(1)
      expect(reload).toHaveBeenCalledTimes(1)

      if (activated) {
        expect(readDesktopUpdatePlan(file)).toBeNull()
        expect(next.$desktopUpdateProgress.get().error).toBeNull()
      } else {
        expect(readDesktopUpdatePlan(file)?.phase).toBe('failed')
        expect(next.$desktopUpdateProgress.get().error).toBe('runtime_target_not_active')
        await next.retryDesktopUpdate({ reload })
        expect(applyUpdate).toHaveBeenCalledTimes(2)
        expect(reload).toHaveBeenCalledTimes(2)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each(['reject', 'throw', 'missing'] as const)('does not reload without a durable attempt receipt (%s)', async failure => {
    const applyUpdate = vi.fn(async () => ({ ok: true, applied: true, reloadRequired: true }))
    window.hermesDesktop = {
      getVersion: async () => ({ appVersion: '0.18.0' }),
      runtime: {
        getVersion: async () => ({ ok: true, key: 'old', version: 'v2026.7.1', treeMatchesMarker: true }),
        checkUpdate: async () => RUNTIME_UPDATE,
        applyUpdate
      },
      updateCenter: {
        getPlan: async () => updatePlan({ planId: `write-failure-${failure}` }),
        transitionPlan: failure === 'missing' ? undefined : async () => {
          if (failure === 'throw') { throw new Error('disk write failed') }

          return { ok: false, error: 'disk write failed' }
        }
      }
    } as unknown as typeof window.hermesDesktop
    const reload = vi.fn()
    await resumeDesktopUpdatePlan({ automatic: true, reload })
    expect(applyUpdate).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: 'update_plan_transition_failed' })
  })

  it('attempts automatic continuation once per frozen plan while permitting a deliberate retry', async () => {
    const plan = updatePlan({ planId: 'bounded-automatic-plan' })
    const applyUpdate = vi.fn(async () => ({ ok: false, error: 'owned install failure' }))
    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.18.0' })),
      runtime: {
        getVersion: vi.fn(async () => ({ ok: true, key: 'old', version: 'v2026.7.1', treeMatchesMarker: true })),
        checkUpdate: vi.fn(async () => RUNTIME_UPDATE),
        applyUpdate
      },
      updateCenter: { getPlan: vi.fn(async () => plan), transitionPlan: vi.fn(async () => ({ ok: true })) }
    } as unknown as typeof window.hermesDesktop
    const reload = vi.fn()
    await resumeDesktopUpdatePlan({ reload, automatic: true })
    await resumeDesktopUpdatePlan({ reload, automatic: true })
    expect(applyUpdate).toHaveBeenCalledTimes(1)
    expect($desktopUpdateProgress.get().error).toBe('owned install failure')
    await retryDesktopUpdate({ reload })
    expect(applyUpdate).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('finishes the persisted shell-only handoff after the bundled engine activates at restart', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-shell-bundle-resume-'))
    const planPath = path.join(home, 'update-plan.json')
    const markerPath = path.join(home, '.hermes-bootstrap-complete')
    const sourcePath = path.join(home, '.hermes-source-commit')
    const oldCommit = 'a'.repeat(40)
    const newCommit = 'b'.repeat(40)
    let activate!: () => void
    const preparing = new Promise<void>(resolve => { activate = resolve })
    writeDesktopUpdatePlan(planPath, {
      kind: 'shell-only', currentShellVersion: '0.17.46', targetShellVersion: '0.17.47',
      currentRuntimeKey: oldCommit, targetRuntimeKey: oldCommit,
      currentRuntimeVersion: 'old engine', targetRuntimeVersion: 'old engine'
    })
    fs.writeFileSync(markerPath, JSON.stringify({ pinnedCommit: oldCommit, version: 'old engine' }))
    fs.writeFileSync(sourcePath, oldCommit)
    const readMarker = () => JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const readTreeCommit = () => fs.readFileSync(sourcePath, 'utf8')

    const gate = createPackagedRuntimeGate(async () => {
      await preparing
      fs.writeFileSync(markerPath, JSON.stringify({ pinnedCommit: newCommit, version: 'bundled engine' }))
      fs.writeFileSync(sourcePath, newCommit)

      return { status: 'installed', runtimeCommit: newCommit }
    })

    const installation = gate()

    const waitForRuntimePreparation = async () => { await gate.waitForPending() }
    const handlers = new Map<string, () => Promise<any>>()
    registerRuntimeVersionIpc({ handle: (channel: string, handler: () => Promise<any>) => handlers.set(channel, handler) } as unknown as Pick<IpcMain, 'handle'>, {
      waitForRuntimePreparation, readMarker, readTreeCommit, minEngineVersion: () => null, log: () => {}
    })

    const clearPlan = vi.fn(async () => { clearDesktopUpdatePlan(planPath);

 return { ok: true } })

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.17.47' })),
      runtime: { getVersion: () => handlers.get('hermes:runtime:version')!(), applyUpdate: vi.fn(), checkUpdate: vi.fn() },
      updateCenter: {
        getPlan: () => readPreparedDesktopUpdatePlan(planPath, {
          waitForRuntimePreparation, preparedRuntime: () => gate.waitForPending(), desktopVersion: () => '0.17.47', readMarker, readTreeCommit
        }),
        clearPlan, transitionPlan: vi.fn(async () => ({ ok: true }))
      }
    } as unknown as typeof window.hermesDesktop
    const resuming = resumeDesktopUpdatePlan({ reload: vi.fn() })

    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(clearPlan).not.toHaveBeenCalled()
      expect(readDesktopUpdatePlan(planPath)?.targetRuntimeKey).toBe(oldCommit)
      activate()
      await installation
      await resuming
      expect($desktopUpdateProgress.get().error).toBeNull()
      expect(clearPlan).toHaveBeenCalledOnce()
      expect(fs.existsSync(planPath)).toBe(false)
      expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null, completedStages: ['check', 'shell', 'restart'] })
      expect(window.hermesDesktop.runtime.applyUpdate).not.toHaveBeenCalled()
      expect(window.hermesDesktop.runtime.checkUpdate).not.toHaveBeenCalled()
    } finally {
      activate()
      await installation
      await resuming
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('applies a ready runtime before the ready shell and uses the shell restart once', async () => {
    const order: string[] = []
    const reload = vi.fn()

    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    $shellUpdate.set(SHELL_UPDATE)
    window.hermesDesktop = {
      runtime: {
        applyUpdate: vi.fn(async () => {
          order.push('runtime')

          return { applied: true, ok: true, reloadRequired: true, latest: { key: 'resolved', version: 'v2026.8.9' } }
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
    expect(window.hermesDesktop.updateCenter?.setShellOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRuntimeKey: 'resolved',
        targetRuntimeVersion: 'v2026.8.9'
      })
    )
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

  it.each([
    {
      error: 'plan write failed',
      path: 'shell required by the runtime',
      runtime: {
        ...RUNTIME_UPDATE,
        desktopUpgradeRequired: { currentDesktopVersion: '0.17.12', minDesktopVersion: '0.18.0' },
        updateAvailable: false
      },
      shell: SHELL_UPDATE
    },
    { error: 'failed_to_persist_update_plan', path: 'shell-only restart', runtime: null, shell: SHELL_UPDATE },
    { error: 'plan write failed', path: 'busy runtime deferral', runtime: RUNTIME_UPDATE, shell: null }
  ])('an unsaved continuation stops the $path before anything restarts', async ({ error, runtime, shell }) => {
    const unsaved = vi.fn(async () => ({ ok: false, error: error === 'failed_to_persist_update_plan' ? undefined : error }))
    const install = vi.fn(async () => ({ ok: true }))

    $runtimeUpdateCheck.set(runtime)
    $shellUpdate.set(shell)
    window.hermesDesktop = {
      runtime: { applyUpdate: vi.fn(async () => ({ ok: true, applied: false, deferred: true })) },
      shellUpdate: { install },
      updateCenter: { setRuntimeAfterShell: unsaved, setShellOnly: unsaved, transitionPlan: vi.fn(async () => ({ ok: true })) }
    } as unknown as typeof window.hermesDesktop

    await expect(applyDesktopUpdates({ reload: vi.fn() })).rejects.toThrow(error)

    expect(unsaved).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error })
  })

  it('keeps the plan through a reload and failed activation, then completes from actual activation', async () => {
    const reload = vi.fn()
    const clearPlan = vi.fn(async () => ({ ok: true }))
    let activeKey = 'old'
    let updateAvailable = true

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.18.0' })),
      runtime: {
        getVersion: vi.fn(async () => ({
          ok: true,
          key: activeKey,
          version: 'v2026.8.8',
          commit: activeKey,
          branch: null
        })),
        checkUpdate: vi.fn(async () => ({ ...RUNTIME_UPDATE, updateAvailable })),
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
    expect(window.hermesDesktop.runtime.applyUpdate).toHaveBeenCalledWith({
      expectedKey: 'new',
      expectedVersion: 'v2026.8.8'
    })
    expect(clearPlan).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)

    updateAvailable = false
    await resumeDesktopUpdatePlan({ reload })
    expect(clearPlan).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get().error).toBe('runtime_target_not_active')

    activeKey = 'new'
    await resumeDesktopUpdatePlan({ reload })
    expect(clearPlan).toHaveBeenCalledTimes(1)
    expect(window.hermesDesktop.runtime.applyUpdate).toHaveBeenCalledTimes(1)
    expect(window.hermesDesktop.runtime.checkUpdate).toHaveBeenCalledTimes(2)
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

  it('fetches the frozen shell again instead of failing when the restart did not install it (hc-1030)', async () => {
    const clearPlan = vi.fn(async () => ({ ok: true }))
    const transitionPlan = vi.fn(async () => ({ ok: true }))
    const check = vi.fn(async () => ({ ok: true, state: { ...SHELL_UPDATE, percent: 12, phase: 'downloading' as const } }))
    const install = vi.fn(async () => ({ ok: true }))

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.17.14' })),
      shellUpdate: { check, getState: vi.fn(async () => null), install, onEvent: vi.fn(() => () => {}) },
      updateCenter: {
        clearPlan,
        getPlan: vi.fn(async () => updatePlan({ kind: 'shell-only' })),
        transitionPlan
      }
    } as unknown as typeof window.hermesDesktop

    await resumeDesktopUpdatePlan({ reload: vi.fn() })

    expect(clearPlan).not.toHaveBeenCalled()
    expect(transitionPlan).toHaveBeenLastCalledWith({ lastError: 'shell_target_redownloading', phase: 'resuming' })
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null })
    expect(check).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
  })

  it('a plan that only waited for its shell to download again still continues automatically (hc-1030)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-shell-wait-'))
    const file = path.join(home, 'plan.json')
    writeDesktopUpdatePlan(file, updatePlan())
    transitionDesktopUpdatePlan(file, { incrementAttempt: true, lastError: 'shell_target_redownloading', phase: 'resuming' })
    let activeKey = 'old'

    const applyUpdate = vi.fn(async () => {
      activeKey = 'new'

      return { ok: true, applied: true, reloadRequired: false }
    })

    window.hermesDesktop = {
      getVersion: async () => ({ appVersion: '0.18.0' }),
      runtime: {
        getVersion: async () => ({ ok: true, key: activeKey, version: 'v2026.8.8', treeMatchesMarker: true, updateDeferred: false }),
        checkUpdate: async () => RUNTIME_UPDATE,
        applyUpdate
      },
      updateCenter: {
        getPlan: async () => readDesktopUpdatePlan(file),
        transitionPlan: async (payload: Parameters<typeof transitionDesktopUpdatePlan>[1]) => ({
          ok: true,
          plan: transitionDesktopUpdatePlan(file, payload)
        }),
        clearPlan: async () => {
          clearDesktopUpdatePlan(file)

          return { ok: true }
        }
      }
    } as unknown as typeof window.hermesDesktop

    try {
      await resumeDesktopUpdatePlan({ reload: vi.fn(), automatic: true })
      expect(applyUpdate).toHaveBeenCalledTimes(1)
      expect(readDesktopUpdatePlan(file)).toBeNull()
      expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: null })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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

  // hc-1030 follow-up: on 2026-10-26 two retries failed with shell_update_not_ready
  // because the check answered on update-available and the cached download landed
  // about 0.5 s later. Pushes are simulated with $shellUpdate.set, as onEvent does.
  function retryBridge(checked: DesktopShellUpdateState, later?: DesktopShellUpdateState) {
    const install = vi.fn(async () => ({ ok: true }))
    const transitionPlan = vi.fn(async () => ({ ok: true }))

    const check = vi.fn(async () => {
      if (later) {setTimeout(() => $shellUpdate.set(later), 500)}

      return { ok: true, state: checked }
    })

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.17.14' })),
      shellUpdate: { check, getState: vi.fn(async () => null), install, onEvent: vi.fn(() => () => {}) },
      updateCenter: { getPlan: vi.fn(async () => updatePlan({ kind: 'shell-only' })), transitionPlan }
    } as unknown as typeof window.hermesDesktop

    return { install, transitionPlan }
  }

  it('a retry waits for the frozen shell the check is still fetching, then installs it (hc-1030)', async () => {
    vi.useFakeTimers()
    const { install, transitionPlan } = retryBridge({ ...SHELL_UPDATE, percent: null, phase: 'available' }, SHELL_UPDATE)
    const retrying = retryDesktopUpdate({ reload: vi.fn() })

    await vi.advanceTimersByTimeAsync(100)
    expect(install).not.toHaveBeenCalled()
    expect($desktopUpdateProgress.get()).toMatchObject({ active: true, currentStage: 'shell', error: null })

    await vi.advanceTimersByTimeAsync(400)
    await retrying

    expect(transitionPlan).toHaveBeenLastCalledWith({ phase: 'ready-to-restart' })
    expect(install).toHaveBeenCalledTimes(1)
    expect($desktopUpdateProgress.get()).toMatchObject({ active: true, currentStage: 'restart', error: null })
  })

  it('a retry whose shell is still downloading after the wait keeps the plan waiting, not failed (hc-1030)', async () => {
    vi.useFakeTimers()
    const { install, transitionPlan } = retryBridge({ ...SHELL_UPDATE, percent: 12, phase: 'downloading' })
    let settled = false
    const retrying = retryDesktopUpdate({ reload: vi.fn() }).then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(9_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(true)
    await retrying

    expect(transitionPlan).toHaveBeenLastCalledWith({ lastError: 'shell_target_redownloading', phase: 'resuming' })
    expect(transitionPlan).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed' }))
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, currentStage: null, error: null })
    expect(install).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'nothing to fetch', checked: { ...SHELL_UPDATE, percent: null, phase: 'idle' as const }, later: undefined },
    { name: 'a different version', checked: { ...SHELL_UPDATE, percent: null, phase: 'available' as const, version: '0.18.1' }, later: undefined },
    {
      name: 'a failed download',
      checked: { ...SHELL_UPDATE, percent: null, phase: 'available' as const },
      later: { ...SHELL_UPDATE, error: 'net::ERR_TIMED_OUT', phase: 'error' as const }
    }
  ])('a retry fails as soon as the frozen shell cannot arrive: $name (hc-1030)', async ({ checked, later }) => {
    vi.useFakeTimers()
    const { install, transitionPlan } = retryBridge(checked, later)
    let failure: unknown = null
    const retrying = retryDesktopUpdate({ reload: vi.fn() }).catch(error => { failure = error })

    await vi.advanceTimersByTimeAsync(500)
    expect(failure).toEqual(new Error('shell_update_not_ready'))
    await retrying

    expect(transitionPlan).toHaveBeenLastCalledWith({ lastError: 'shell_update_not_ready', phase: 'failed' })
    expect($desktopUpdateProgress.get()).toMatchObject({ active: false, error: 'shell_update_not_ready' })
    expect(install).not.toHaveBeenCalled()
  })

  it.each([
    ['shell-only', false],
    ['shell-only', true],
    ['runtime-after-shell', false],
    ['runtime-after-shell', true]
  ] as const)('waits for the actual version IPC before finishing a %s plan (failure=%s)', async (kind, failure) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-update-resume-'))
    const markerPath = path.join(home, '.hermes-bootstrap-complete')
    const sourcePath = path.join(home, '.hermes-source-commit')
    const oldKey = 'a'.repeat(40)
    const targetKey = 'b'.repeat(40)
    const plan = updatePlan({ kind, targetRuntimeKey: targetKey })
    const clearPlan = vi.fn(async () => ({ ok: true }))
    let release!: () => void

    const preparation = new Promise<void>(resolve => {
      release = resolve
    })

    const lifecycle = createLocalBackendLifecycle({
      stopChild: vi.fn(() => {
        throw new Error('A version read must not stop a worker')
      }),
      waitForExit: vi.fn(async () => {}),
      cancelSetup: vi.fn()
    })

    const gate = createPackagedRuntimeGate(async () => {
      throw new Error('A version read must not start an install')
    })

    const reads = vi.fn(() => (fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null))
    const handlers = new Map<string, () => Promise<any>>()

    const ipcMain = {
      handle: (channel: string, handler: () => Promise<any>) => handlers.set(channel, handler)
    } as unknown as Pick<IpcMain, 'handle'>

    registerRuntimeVersionIpc(ipcMain, {
      waitForRuntimePreparation: () =>
        waitForPendingRuntimePreparation({
          isPackaged: true,
          diagnostic: false,
          remote: false,
          managedRestorePending: false,
          waitForPendingStarts: lifecycle.waitForPendingStarts,
          waitForPackagedEngine: gate.waitForPending
        }),
      readMarker: reads,
      readTreeCommit: () => fs.readFileSync(sourcePath, 'utf8'),
      minEngineVersion: () => null,
      log: () => {}
    })

    // The opt-in legacy bootstrap starts with its marker removed. Activation or
    // rollback happens only after the explicitly controlled preparation event.
    const startup = lifecycle
      .start(async () => {
        await preparation
        const key = failure ? oldKey : targetKey
        fs.writeFileSync(markerPath, JSON.stringify({ pinnedCommit: key, version: plan.targetRuntimeVersion }))
        fs.writeFileSync(sourcePath, key)

        if (failure) {
          throw new Error('Preparation failed; restored the old engine')
        }
      })
      .catch(() => {})

    window.hermesDesktop = {
      getVersion: vi.fn(async () => ({ appVersion: '0.18.0' })),
      runtime: {
        getVersion: () => handlers.get('hermes:runtime:version')!(),
        checkUpdate: vi.fn(async () => ({
          ...RUNTIME_UPDATE,
          latest: { key: targetKey, version: plan.targetRuntimeVersion },
          updateAvailable: false
        })),
        applyUpdate: vi.fn()
      },
      updateCenter: { getPlan: vi.fn(async () => plan), clearPlan, transitionPlan: vi.fn(async () => ({ ok: true })) }
    } as unknown as typeof window.hermesDesktop
    const resuming = resumeDesktopUpdatePlan({ reload: vi.fn() })

    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(reads).not.toHaveBeenCalled()
      expect(clearPlan).not.toHaveBeenCalled()
      expect($desktopUpdateProgress.get()).toMatchObject({ active: true, error: null })
      release()
      await startup
      await resuming
      expect(clearPlan).toHaveBeenCalledTimes(failure ? 0 : 1)
      expect($desktopUpdateProgress.get()).toMatchObject({
        active: false,
        error: failure ? 'runtime_target_not_active' : null
      })
      expect(window.hermesDesktop.runtime.applyUpdate).not.toHaveBeenCalled()
    } finally {
      release()
      await startup
      await resuming
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([
    { kind: 'shell-only', ok: false, treeMatchesMarker: true, latestKey: 'new', expected: 'runtime_target_not_active' },
    { kind: 'shell-only', ok: true, treeMatchesMarker: false, latestKey: 'new', expected: 'runtime_target_not_active' },
    {
      kind: 'runtime-after-shell',
      ok: false,
      treeMatchesMarker: true,
      latestKey: 'new',
      expected: 'runtime_target_not_active'
    },
    {
      kind: 'runtime-after-shell',
      ok: true,
      treeMatchesMarker: false,
      latestKey: 'new',
      expected: 'runtime_target_not_active'
    },
    {
      kind: 'runtime-after-shell',
      ok: false,
      treeMatchesMarker: true,
      latestKey: 'different-commit',
      expected: 'runtime_target_changed'
    },
    { kind: 'runtime-after-shell', ok: true, treeMatchesMarker: true, latestKey: 'different-commit', expected: null },
    { kind: 'shell-only', ok: true, treeMatchesMarker: true, latestKey: 'different-commit', expected: null }
  ] as const)(
    'requires actual activation for $kind (ok=$ok, tree=$treeMatchesMarker, latest=$latestKey)',
    async row => {
      const clearPlan = vi.fn(async () => ({ ok: true }))

      const checkUpdate = vi.fn(async () => ({
        ...RUNTIME_UPDATE,
        latest: { key: row.latestKey, version: RUNTIME_UPDATE.latest!.version },
        updateAvailable: false
      }))

      const install = vi.fn()
      window.hermesDesktop = {
        getVersion: vi.fn(async () => ({ appVersion: '0.18.1' })),
        runtime: {
          getVersion: vi.fn(async () => ({
            ok: row.ok,
            key: 'new',
            version: 'v2026.8.8',
            commit: 'new',
            branch: null,
            treeMatchesMarker: row.treeMatchesMarker
          })),
          checkUpdate,
          applyUpdate: vi.fn()
        },
        shellUpdate: { install },
        updateCenter: {
          getPlan: vi.fn(async () => updatePlan({ kind: row.kind })),
          clearPlan,
          transitionPlan: vi.fn(async () => ({ ok: true }))
        }
      } as unknown as typeof window.hermesDesktop

      await retryDesktopUpdate({ reload: vi.fn() })

      expect(clearPlan).toHaveBeenCalledTimes(row.expected ? 0 : 1)
      expect($desktopUpdateProgress.get().error).toBe(row.expected)
      expect(install).not.toHaveBeenCalled()
      expect(window.hermesDesktop.runtime.applyUpdate).not.toHaveBeenCalled()

      if (!row.expected) {
        expect(checkUpdate).not.toHaveBeenCalled()
      }
    }
  )
})
