import { atom } from 'nanostores'

import type { DesktopRuntimeUpdateCheck, DesktopRuntimeUpdateProgress, DesktopShellUpdateState } from '@/global'

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
  runtimeProgress: DesktopRuntimeUpdateProgress | null
  stages: DesktopUpdateStage[]
  targetVersion: string | null
}

const EMPTY_PROGRESS: DesktopUpdateProgress = {
  active: false,
  completedStages: [],
  currentStage: null,
  error: null,
  runtimeProgress: null,
  stages: [],
  targetVersion: null
}

export const $desktopUpdateProgress = atom<DesktopUpdateProgress>(EMPTY_PROGRESS)

let resumePromise: Promise<void> | null = null
let runtimeProgressSubscribed = false
let shellProgressSubscribed = false

function setProgress(patch: Partial<DesktopUpdateProgress>): void {
  $desktopUpdateProgress.set({ ...$desktopUpdateProgress.get(), ...patch })
}

function initDesktopUpdateProgressSubscription(): void {
  if (!shellProgressSubscribed) {
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

  const onRuntimeProgress = window.hermesDesktop?.runtime?.onUpdateProgress

  if (!runtimeProgressSubscribed && onRuntimeProgress) {
    runtimeProgressSubscribed = true
    onRuntimeProgress(runtimeProgress => {
      const progress = $desktopUpdateProgress.get()

      if (progress.active && progress.currentStage === 'runtime') {
        setProgress({ runtimeProgress })
      }
    })
  }
}

function comparableVersion(value: string | null | undefined): string {
  return (value || '').trim().replace(/^v/i, '')
}

function runtimeTarget(check: DesktopRuntimeUpdateCheck | null): string | null {
  return check?.latest?.version ?? check?.latest?.key ?? null
}

function runtimeCurrent(check: DesktopRuntimeUpdateCheck | null): string | null {
  return check?.current?.version ?? check?.current?.key ?? null
}

function runtimeCurrentKey(check: DesktopRuntimeUpdateCheck | null): string | null {
  return check?.current?.key ?? null
}

function runtimeTargetKey(check: DesktopRuntimeUpdateCheck | null): string | null {
  return check?.latest?.key ?? null
}

async function transitionPlanSafely(payload: {
  phase: 'failed' | 'ready-to-restart' | 'resuming'
  lastError?: string | null
  incrementAttempt?: boolean
}): Promise<void> {
  try {
    await window.hermesDesktop?.updateCenter?.transitionPlan?.(payload)
  } catch {
    // The transition is diagnostic state. A broken IPC bridge must not mask
    // the original update failure or prevent the current app from staying up.
  }
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
    runtimeProgress: null,
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
        currentRuntimeKey: runtimeCurrentKey(runtime),
        currentRuntimeVersion: runtimeCurrent(runtime),
        targetRuntimeKey: runtimeTargetKey(runtime),
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
        currentStage: 'restart',
        runtimeProgress: null
      })
    }

    if (needsShell) {
      const result = await window.hermesDesktop?.updateCenter?.setShellOnly({
        currentRuntimeKey: runtimeCurrentKey(runtime),
        currentRuntimeVersion: runtimeCurrent(runtime),
        targetRuntimeKey: runtime?.updateAvailable ? runtimeTargetKey(runtime) : runtimeCurrentKey(runtime),
        targetRuntimeVersion: runtime?.updateAvailable ? runtimeTarget(runtime) : runtimeCurrent(runtime),
        targetShellVersion: shell?.version ?? null
      })

      if (!result?.ok) {
        throw new Error(result?.error || 'failed_to_persist_update_plan')
      }

      await installShellUpdate()

      return
    }

    if (runtimeReloadRequired) {
      reload()

      return
    }

    setProgress({ active: false, completedStages: stages, currentStage: null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    await transitionPlanSafely({
      lastError: message,
      phase: 'failed'
    })
    setProgress({
      active: false,
      currentStage: null,
      error: message
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

    await transitionPlanSafely({ incrementAttempt: true, phase: 'resuming' })

    setProgress({
      active: true,
      completedStages: ['check', 'shell'],
      currentStage: 'runtime',
      error: null,
      runtimeProgress: null,
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

      if (plan.kind === 'shell-only') {
        if (plan.targetRuntimeKey || plan.targetRuntimeVersion) {
          const runningRuntime = await loadRuntimeVersion()
          const targetRuntime = plan.targetRuntimeKey ?? plan.targetRuntimeVersion
          const runningRuntimeIdentity = plan.targetRuntimeKey ? runningRuntime.key : runningRuntime.version

          if (comparableVersion(runningRuntimeIdentity) !== comparableVersion(targetRuntime)) {
            throw new Error('runtime_target_not_active')
          }
        }

        await bridge?.clearPlan()
        setProgress({
          active: false,
          completedStages: ['check', 'shell', 'restart'],
          currentStage: null,
          runtimeProgress: null,
          stages: ['check', 'shell', 'restart']
        })

        return
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
        currentStage: 'restart',
        runtimeProgress: null
      })

      if (reloadRequired) {
        reload()
      } else {
        setProgress({ active: false, completedStages: ['check', 'shell', 'runtime', 'restart'], currentStage: null })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      await transitionPlanSafely({ lastError: message, phase: 'failed' })
      setProgress({
        active: false,
        currentStage: null,
        error: message
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
  const bridge = window.hermesDesktop?.updateCenter
  const plan = await bridge?.getPlan()

  if (plan) {
    if (plan.kind === 'shell-only') {
      const runningDesktop = await window.hermesDesktop?.getVersion?.()

      if (
        plan.targetShellVersion &&
        comparableVersion(runningDesktop?.appVersion) !== comparableVersion(plan.targetShellVersion)
      ) {
        await checkShellUpdate()
        const shell = $shellUpdate.get()

        if (!shellReady(shell) || comparableVersion(shell?.version) !== comparableVersion(plan.targetShellVersion)) {
          await transitionPlanSafely({ lastError: 'shell_update_not_ready', phase: 'failed' })
          setProgress({ active: false, currentStage: null, error: 'shell_update_not_ready' })
          throw new Error('shell_update_not_ready')
        }

        await transitionPlanSafely({ phase: 'ready-to-restart' })
        setProgress({
          active: true,
          completedStages: ['check', 'shell'],
          currentStage: 'restart',
          error: null,
          runtimeProgress: null,
          stages: ['check', 'shell', 'restart'],
          targetVersion: plan.targetShellVersion
        })
        await installShellUpdate()

        return
      }
    }

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
