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
