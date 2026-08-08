import { atom } from 'nanostores'

import type { DesktopRuntimeUpdateCheck, DesktopShellUpdateState } from '@/global'

import {
  $runtimeUpdateCheck,
  applyRuntimeUpdate,
  checkRuntimeUpdate,
  loadRuntimeVersion
} from './runtime-update'
import { $shellUpdate, checkShellUpdate, initShellUpdateSubscription, installShellUpdate } from './shell-update'

export type DesktopUpdateStage = 'check' | 'restart' | 'runtime' | 'shell'

export interface DesktopUpdateProgress {
  active: boolean
  completedStages: DesktopUpdateStage[]
  currentStage: DesktopUpdateStage | null
  error: string | null
  stages: DesktopUpdateStage[]
  targetVersion: string | null
}

const EMPTY_PROGRESS: DesktopUpdateProgress = {
  active: false,
  completedStages: [],
  currentStage: null,
  error: null,
  stages: [],
  targetVersion: null
}

export const $desktopUpdateProgress = atom<DesktopUpdateProgress>(EMPTY_PROGRESS)

let resumePromise: Promise<void> | null = null
let shellProgressSubscribed = false

function setProgress(patch: Partial<DesktopUpdateProgress>): void {
  $desktopUpdateProgress.set({ ...$desktopUpdateProgress.get(), ...patch })
}

function initDesktopUpdateProgressSubscription(): void {
  if (shellProgressSubscribed) {
    return
  }

  shellProgressSubscribed = true
  $shellUpdate.listen(state => {
    const progress = $desktopUpdateProgress.get()

    // quitAndInstall answers IPC before Electron tears the window down. If the
    // native hand-off then throws, shell-updater can only report it through its
    // event stream; translate that late error back into the shared surface.
    if (state?.phase === 'error' && progress.active && progress.currentStage === 'restart') {
      setProgress({ active: false, currentStage: null, error: state.error || 'shell_update_apply_failed' })
    }
  })
}

function comparableVersion(value: string | null | undefined): string {
  return (value || '').trim().replace(/^v/i, '')
}

function runtimeTarget(check: DesktopRuntimeUpdateCheck | null): string | null {
  return check?.latest?.version ?? check?.latest?.key ?? null
}

function shellReady(state: DesktopShellUpdateState | null): boolean {
  return state?.phase === 'downloaded'
}

function updateStages({ needsRuntime, needsShell }: { needsRuntime: boolean; needsShell: boolean }): DesktopUpdateStage[] {
  return [
    'check',
    ...(needsShell ? (['shell'] as DesktopUpdateStage[]) : []),
    ...(needsRuntime ? (['runtime'] as DesktopUpdateStage[]) : []),
    'restart'
  ]
}

export async function checkDesktopUpdates(): Promise<{
  runtime: DesktopRuntimeUpdateCheck
  shell: DesktopShellUpdateState | null
}> {
  initDesktopUpdateProgressSubscription()
  initShellUpdateSubscription()
  const [runtime, shell] = await Promise.all([checkRuntimeUpdate(), checkShellUpdate()])

  await loadRuntimeVersion()

  return { runtime, shell }
}

export async function applyDesktopUpdates(options: { reload?: () => void } = {}): Promise<void> {
  initDesktopUpdateProgressSubscription()
  const reload = options.reload ?? (() => window.location.reload())
  const runtime = $runtimeUpdateCheck.get()
  const shell = $shellUpdate.get()
  const needsRuntime = Boolean(runtime?.updateAvailable || runtime?.desktopUpgradeRequired)
  const needsShell = shellReady(shell)

  if (!needsRuntime && !needsShell) {
    throw new Error('no_update_ready')
  }

  const stages = updateStages({ needsRuntime, needsShell })
  const completedStages: DesktopUpdateStage[] = ['check', ...(needsShell ? (['shell'] as DesktopUpdateStage[]) : [])]

  setProgress({
    active: true,
    completedStages,
    currentStage: needsRuntime && runtime?.updateAvailable ? 'runtime' : 'restart',
    error: null,
    stages,
    targetVersion: runtimeTarget(runtime) ?? shell?.version ?? null
  })

  try {
    // The target runtime requires a newer shell. Persist the continuation before
    // quitAndInstall; the new shell resumes it automatically after relaunch.
    if (runtime?.desktopUpgradeRequired) {
      if (!needsShell) {
        throw new Error('desktop_update_required_but_not_ready')
      }

      const result = await window.hermesDesktop?.updateCenter?.setRuntimeAfterShell({
        targetRuntimeVersion: runtimeTarget(runtime),
        targetShellVersion: shell?.version ?? null
      })

      if (!result?.ok) {
        throw new Error(result?.error || 'failed_to_persist_update_plan')
      }

      setProgress({ currentStage: 'restart' })
      await installShellUpdate()

      return
    }

    let runtimeReloadRequired = false

    if (runtime?.updateAvailable) {
      const result = await applyRuntimeUpdate()

      runtimeReloadRequired = Boolean(result.reloadRequired)
      setProgress({
        completedStages: [...completedStages, 'runtime'],
        currentStage: 'restart'
      })
    }

    if (needsShell) {
      await installShellUpdate()

      return
    }

    if (runtimeReloadRequired) {
      reload()

      return
    }

    setProgress({ active: false, completedStages: stages, currentStage: null })
  } catch (error) {
    setProgress({
      active: false,
      currentStage: null,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

export function resumeDesktopUpdatePlan(options: { reload?: () => void } = {}): Promise<void> {
  if (resumePromise) {
    return resumePromise
  }

  const reload = options.reload ?? (() => window.location.reload())

  resumePromise = (async () => {
    const bridge = window.hermesDesktop?.updateCenter
    const plan = await bridge?.getPlan()

    if (!plan) {
      return
    }

    setProgress({
      active: true,
      completedStages: ['check', 'shell'],
      currentStage: 'runtime',
      error: null,
      stages: ['check', 'shell', 'runtime', 'restart'],
      targetVersion: plan.targetRuntimeVersion
    })

    try {
      const runningDesktop = await window.hermesDesktop?.getVersion?.()

      if (
        plan.targetShellVersion &&
        runningDesktop?.appVersion &&
        comparableVersion(runningDesktop.appVersion) !== comparableVersion(plan.targetShellVersion)
      ) {
        throw new Error('shell_target_not_running')
      }

      const runtime = await checkRuntimeUpdate()

      if (!runtime.ok) {
        throw new Error(runtime.error || 'runtime_check_failed')
      }

      if (runtime.desktopUpgradeRequired) {
        throw new Error('updated_shell_still_incompatible')
      }

      if (
        plan.targetRuntimeVersion &&
        comparableVersion(runtimeTarget(runtime)) !== comparableVersion(plan.targetRuntimeVersion)
      ) {
        throw new Error('runtime_target_changed')
      }

      let reloadRequired = false

      if (runtime.updateAvailable) {
        const result = await applyRuntimeUpdate()

        reloadRequired = Boolean(result.reloadRequired)
      }

      await bridge?.clearPlan()
      setProgress({
        completedStages: ['check', 'shell', 'runtime'],
        currentStage: 'restart'
      })

      if (reloadRequired) {
        reload()
      } else {
        setProgress({ active: false, completedStages: ['check', 'shell', 'runtime', 'restart'], currentStage: null })
      }
    } catch (error) {
      setProgress({
        active: false,
        currentStage: null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })().finally(() => {
    resumePromise = null
  })

  return resumePromise
}

export function dismissDesktopUpdateError(): void {
  $desktopUpdateProgress.set(EMPTY_PROGRESS)
}

export async function retryDesktopUpdate(options: { reload?: () => void } = {}): Promise<void> {
  dismissDesktopUpdateError()
  const plan = await window.hermesDesktop?.updateCenter?.getPlan()

  if (plan) {
    await resumeDesktopUpdatePlan(options)

    return
  }

  await applyDesktopUpdates(options)
}

export function desktopUpdateAvailability(): {
  needsRuntime: boolean
  needsShell: boolean
  preparingShell: boolean
} {
  const runtime = $runtimeUpdateCheck.get()
  const shell = $shellUpdate.get()

  return {
    needsRuntime: Boolean(runtime?.updateAvailable || runtime?.desktopUpgradeRequired),
    needsShell: shellReady(shell),
    preparingShell: shell?.phase === 'available' || shell?.phase === 'downloading'
  }
}
