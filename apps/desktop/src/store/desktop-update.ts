import { atom } from 'nanostores'

import type {
  DesktopRuntimeUpdateCheck,
  DesktopRuntimeUpdateProgress,
  DesktopRuntimeVersion,
  DesktopShellUpdateState,
  DesktopUpdatePlan
} from '@/global'

import { $runtimeUpdateCheck, applyRuntimeUpdate, checkRuntimeUpdate, loadRuntimeVersion } from './runtime-update'
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
let attemptedAutomaticPlan: string | null = null
let runtimeProgressSubscribed = false
let shellProgressSubscribed = false
let deferredRetry: ReturnType<typeof setTimeout> | undefined

async function deferRuntimeUpdate(reload: () => void): Promise<void> {
  // Preserve the exact target and show the working chat while the native gate
  // waits. No completed receipt, failed modal, or reload loop for busy engines.
  await transitionPlanSafely({ phase: 'resuming', lastError: 'runtime_update_busy' })
  setProgress({ active: false, currentStage: null, error: null })
  clearTimeout(deferredRetry)
  deferredRetry = setTimeout(() => {
    attemptedAutomaticPlan = null
    void resumeDesktopUpdatePlan({ automatic: true, reload }).catch(error => {
      console.error('[desktop-update] deferred plan could not be resumed', error)
    })
  }, 30_000)
}

async function installShellWhenIdle(): Promise<void> {
  const result = await installShellUpdate()
  if (result.deferred) {setProgress({ active: false, currentStage: null, error: null })}
}

export async function queueDeferredRuntimeUpdate(runtime: DesktopRuntimeUpdateCheck | null, options: {
  reload?: () => void
  targetShellVersion?: string | null
} = {}): Promise<void> {
  const saved = await window.hermesDesktop?.updateCenter?.setRuntimeAfterShell({
    currentRuntimeKey: runtimeCurrentKey(runtime), currentRuntimeVersion: runtimeCurrent(runtime),
    targetRuntimeKey: runtimeTargetKey(runtime), targetRuntimeVersion: runtimeTarget(runtime),
    targetShellVersion: options.targetShellVersion ?? null
  })

  requirePlanSaved(saved)
  await deferRuntimeUpdate(options.reload ?? (() => window.location.reload()))
}


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

function shellMeetsPlan(current: string | null | undefined, target: string | null): boolean {
  if (!target) {
    return true
  }

  const actual = comparableVersion(current)
  const expected = comparableVersion(target)

  if (actual === expected) {
    return true
  }

  const actualParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(actual)?.slice(1).map(Number)
  const expectedParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(expected)?.slice(1).map(Number)

  if (!actualParts || !expectedParts) {
    return false
  }

  const difference = actualParts.map((part, index) => part - expectedParts[index]).find(part => part !== 0)

  return difference !== undefined && difference > 0
}

function runtimeMatchesPlan(runtime: DesktopRuntimeVersion, plan: DesktopUpdatePlan): boolean {
  if (!runtime.ok || runtime.treeMatchesMarker === false) {
    return false
  }

  const target = plan.targetRuntimeKey ?? plan.targetRuntimeVersion
  const current = plan.targetRuntimeKey ? runtime.key : runtime.version

  return Boolean(target) && comparableVersion(current) === comparableVersion(target)
}

/** The checked runtime no longer offers the target this plan froze. */
function runtimeTargetChanged(runtime: DesktopRuntimeUpdateCheck, plan: DesktopUpdatePlan): boolean {
  return Boolean(
    (plan.targetRuntimeKey &&
      comparableVersion(runtimeTargetKey(runtime)) !== comparableVersion(plan.targetRuntimeKey)) ||
      (plan.targetRuntimeVersion &&
        comparableVersion(runtimeTarget(runtime)) !== comparableVersion(plan.targetRuntimeVersion))
  )
}

/** hc-1030: the restart did not install the planned shell; the same target is being fetched again. */
const SHELL_TARGET_REDOWNLOADING = 'shell_target_redownloading'

/** A plan that already failed or ran is not resumed automatically again, unless it only waited (busy engine, shell fetched again). */
function automaticRetrySpent(plan: DesktopUpdatePlan): boolean {
  const waited = plan.lastError === 'runtime_update_busy' || plan.lastError === SHELL_TARGET_REDOWNLOADING

  return !waited && (plan.attempts > 0 || plan.phase === 'failed')
}

/** The plan's frozen shell is downloaded but not running yet. */
function plannedShellDownloaded(plan: DesktopUpdatePlan): boolean {
  const shell = $shellUpdate.get()

  return shellReady(shell) && comparableVersion(shell?.version) === comparableVersion(plan.targetShellVersion)
}

/** The plan's frozen shell is still being fetched: a check resolves on update-available, before the download lands. */
function plannedShellFetching(plan: DesktopUpdatePlan): boolean {
  const shell = $shellUpdate.get()
  const fetching = shell?.phase === 'checking' || shell?.phase === 'available' || shell?.phase === 'downloading'

  return fetching && comparableVersion(shell?.version) === comparableVersion(plan.targetShellVersion)
}

/** How long a retry waits for the frozen shell. A cached download lands about a second after the check. */
const SHELL_DOWNLOAD_WAIT_MS = 10_000

/** hc-1030: true once the frozen shell is downloaded; false when it stops being fetched or the wait runs out. */
async function plannedShellArrives(plan: DesktopUpdatePlan): Promise<boolean> {
  let stop = (): void => {}
  let timer: ReturnType<typeof setTimeout> | undefined

  const settled = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), SHELL_DOWNLOAD_WAIT_MS)
    stop = $shellUpdate.subscribe(() => {
      if (!plannedShellFetching(plan)) {
        resolve(plannedShellDownloaded(plan))
      }
    })
  })

  try {
    return await settled
  } finally {
    stop()
    clearTimeout(timer)
  }
}

/** hc-1030: the plan waits, not failed, while its shell is fetched again; the sidebar offers it once downloaded. */
async function waitForShellRedownload(): Promise<void> {
  await transitionPlanSafely({ lastError: SHELL_TARGET_REDOWNLOADING, phase: 'resuming' })
  setProgress({ active: false, currentStage: null, error: null })
}

/** A continuation the main process could not persist stops the update before anything restarts. */
function requirePlanSaved(result: { error?: string; ok: boolean } | null | undefined): void {
  if (!result?.ok) {
    throw new Error(result?.error || 'failed_to_persist_update_plan')
  }
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

function updateStages({
  needsRuntime,
  needsShell
}: {
  needsRuntime: boolean
  needsShell: boolean
}): DesktopUpdateStage[] {
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

      requirePlanSaved(result)

      setProgress({ currentStage: 'restart' })
      await installShellWhenIdle()

      return
    }

    let runtimeReloadRequired = false
    let appliedRuntimeTarget = runtime?.latest ?? null

    if (runtime?.updateAvailable) {
      const result = await applyRuntimeUpdate()
      if (result.deferred) {
        await queueDeferredRuntimeUpdate(runtime, { reload, targetShellVersion: needsShell ? shell?.version : null })
        return
      }

      runtimeReloadRequired = Boolean(result.reloadRequired)
      appliedRuntimeTarget = result.latest ?? appliedRuntimeTarget
      setProgress({
        completedStages: [...completedStages, 'runtime'],
        currentStage: 'restart',
        runtimeProgress: null,
        targetVersion: appliedRuntimeTarget?.version ?? appliedRuntimeTarget?.key ?? null
      })
    }

    if (needsShell) {
      const result = await window.hermesDesktop?.updateCenter?.setShellOnly({
        currentRuntimeKey: runtimeCurrentKey(runtime),
        currentRuntimeVersion: runtimeCurrent(runtime),
        targetRuntimeKey: runtime?.updateAvailable ? appliedRuntimeTarget?.key : runtimeCurrentKey(runtime),
        targetRuntimeVersion: runtime?.updateAvailable ? appliedRuntimeTarget?.version : runtimeCurrent(runtime),
        targetShellVersion: shell?.version ?? null
      })

      requirePlanSaved(result)

      await installShellWhenIdle()

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

export function resumeDesktopUpdatePlan(options: { reload?: () => void; automatic?: boolean } = {}): Promise<void> {
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

    if (options.automatic) {
      const identity = JSON.stringify([plan.planId || 'legacy', plan.targetShellVersion, plan.targetRuntimeKey, plan.targetRuntimeVersion])

      if (attemptedAutomaticPlan === identity) {return}
      attemptedAutomaticPlan = identity
    }

    // This receipt survives the reload that activates the engine. An in-memory
    // latch alone re-arms a failed update on every fresh renderer.
    let attemptRecorded = false

    try {
      const receipt = await bridge?.transitionPlan?.({ incrementAttempt: true, phase: 'resuming' })
      attemptRecorded = receipt?.ok === true
    } catch {
      // Readback may still prove an already-finished update; only a new apply
      // requires a durable attempt record.
    }

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

      if (!shellMeetsPlan(runningDesktop?.appVersion, plan.targetShellVersion)) {
        if (!plannedShellDownloaded(plan)) {
          // hc-1030: this restart did not run the installer (a deferred install, an early
          // quit, a failed hand-off) and the new process has not fetched the target yet.
          // Fetch it now and let the update entry offer it again instead of failing.
          await waitForShellRedownload()
          void checkShellUpdate().catch(() => {})

          return
        }

        // Ask for the downloaded target shell again; its install waits for idle.
        await installShellWhenIdle()

        return
      }

      const runningRuntime = await loadRuntimeVersion()
      if (runningRuntime.updateDeferred) {
        await deferRuntimeUpdate(reload)
        return
      }

      if (plan.kind === 'shell-only') {
        if (plan.targetRuntimeKey || plan.targetRuntimeVersion) {
          const runningRuntime = await loadRuntimeVersion()

          if (!runtimeMatchesPlan(runningRuntime, plan)) {
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

      // A prior reload can already have activated the frozen target. Complete
      // from local evidence even when the online default has since advanced.
      if (runtimeMatchesPlan(await loadRuntimeVersion(), plan)) {
        await bridge?.clearPlan()
        setProgress({ active: false, completedStages: ['check', 'shell', 'runtime', 'restart'], currentStage: null })

        return
      }

      if (options.automatic && automaticRetrySpent(plan)) {
        throw new Error(plan.lastError || 'runtime_target_not_active')
      }

      const runtime = await checkRuntimeUpdate()

      if (!runtime.ok) {
        throw new Error(runtime.error || 'runtime_check_failed')
      }

      if (runtime.desktopUpgradeRequired) {
        throw new Error('updated_shell_still_incompatible')
      }

      if (runtimeTargetChanged(runtime, plan)) {
        throw new Error('runtime_target_changed')
      }

      if (runtime.updateAvailable) {
        if (!attemptRecorded) {
          throw new Error('update_plan_transition_failed')
        }

        const result = await applyRuntimeUpdate({
          expectedKey: plan.targetRuntimeKey,
          expectedVersion: plan.targetRuntimeVersion
        })

        if (result.deferred) {
          await deferRuntimeUpdate(reload)
          return
        }
        if (result.reloadRequired) {
          // Legacy bootstrap activates after reloading. Retain the durable
          // plan until the next renderer verifies the actual installed tree.
          setProgress({ currentStage: 'restart', runtimeProgress: null })
          reload()

          return
        }
      }

      if (!runtimeMatchesPlan(await loadRuntimeVersion(), plan)) {
        throw new Error('runtime_target_not_active')
      }

      await bridge?.clearPlan()
      setProgress({
        active: false,
        completedStages: ['check', 'shell', 'runtime', 'restart'],
        currentStage: null,
        runtimeProgress: null
      })
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
  clearTimeout(deferredRetry)
  $desktopUpdateProgress.set(EMPTY_PROGRESS)
}

export async function retryDesktopUpdate(options: { reload?: () => void } = {}): Promise<void> {
  dismissDesktopUpdateError()
  const bridge = window.hermesDesktop?.updateCenter
  const plan = await bridge?.getPlan()

  if (plan) {
    if (plan.kind === 'shell-only') {
      const runningDesktop = await window.hermesDesktop?.getVersion?.()

      if (!shellMeetsPlan(runningDesktop?.appVersion, plan.targetShellVersion)) {
        await checkShellUpdate()
        setProgress({
          active: true,
          completedStages: ['check'],
          currentStage: 'shell',
          error: null,
          runtimeProgress: null,
          stages: ['check', 'shell', 'restart'],
          targetVersion: plan.targetShellVersion
        })

        // hc-1030: the check answers before the download, even a cached one, lands.
        if (!(await plannedShellArrives(plan))) {
          if (plannedShellFetching(plan)) {
            await waitForShellRedownload()

            return
          }

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
        await installShellWhenIdle()

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
