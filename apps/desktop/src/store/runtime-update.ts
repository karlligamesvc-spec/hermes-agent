/**
 * Desktop engine (runtime) opt-in update store — R5/R6 of the runtime 3-end
 * consistency epic.
 *
 * This is a thin renderer-side wrapper over the existing IPC bridge
 * (window.hermesDesktop.runtime.{checkUpdate, applyUpdate}); the actual
 * mechanism lives in electron/apex-runtime-latest.cjs and the main.cjs
 * handlers. We only own UI state here:
 *   - the last check result (installed engine version + admin-latest), so the
 *     About panel can show the current version (R6) and offer an update (R5),
 *   - in-flight flags for the check / apply buttons.
 *
 * Opt-in: nothing here runs on its own. The user must click to check and click
 * (then confirm) to apply.
 */

import { atom } from 'nanostores'

import type { DesktopRuntimeUpdateApply, DesktopRuntimeUpdateCheck } from '@/global'

export const $runtimeUpdateCheck = atom<DesktopRuntimeUpdateCheck | null>(null)
export const $runtimeUpdateChecking = atom<boolean>(false)
export const $runtimeUpdateApplying = atom<boolean>(false)

/**
 * Run an opt-in engine update check. Stores and returns the result. Never
 * throws — a thrown/rejected bridge call is normalized to an ok:false result so
 * the panel can show a friendly "couldn't reach" line instead of a crash.
 */
export async function checkRuntimeUpdate(): Promise<DesktopRuntimeUpdateCheck> {
  const bridge = window.hermesDesktop?.runtime

  if (!bridge?.checkUpdate) {
    const unsupported: DesktopRuntimeUpdateCheck = {
      ok: false,
      updateAvailable: false,
      current: { version: null, key: null },
      latest: null,
      error: 'unsupported'
    }

    $runtimeUpdateCheck.set(unsupported)

    return unsupported
  }

  $runtimeUpdateChecking.set(true)

  try {
    const result = await bridge.checkUpdate()
    $runtimeUpdateCheck.set(result)

    return result
  } catch (error) {
    const failed: DesktopRuntimeUpdateCheck = {
      ok: false,
      updateAvailable: false,
      current: $runtimeUpdateCheck.get()?.current ?? { version: null, key: null },
      latest: null,
      error: error instanceof Error ? error.message : String(error)
    }

    $runtimeUpdateCheck.set(failed)

    return failed
  } finally {
    $runtimeUpdateChecking.set(false)
  }
}

/**
 * Apply the opt-in engine update. Returns the bridge result. On
 * `reloadRequired`, the caller reloads the window to drive the bootstrap
 * re-run. Throws on a non-ok result so a confirm dialog surfaces the error
 * inline (and keeps itself open) rather than silently no-op'ing.
 */
export async function applyRuntimeUpdate(): Promise<DesktopRuntimeUpdateApply> {
  const bridge = window.hermesDesktop?.runtime

  if (!bridge?.applyUpdate) {
    throw new Error('unsupported')
  }

  $runtimeUpdateApplying.set(true)

  try {
    const result = await bridge.applyUpdate()

    if (!result.ok) {
      throw new Error(result.error || 'apply_failed')
    }

    return result
  } finally {
    $runtimeUpdateApplying.set(false)
  }
}
