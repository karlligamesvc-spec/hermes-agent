/**
 * Desktop engine (runtime) opt-in update store — R5/R6 of the runtime 3-end
 * consistency epic.
 *
 * This is a thin renderer-side wrapper over the existing IPC bridge
 * (window.hermesDesktop.runtime.{getVersion, checkUpdate, applyUpdate}); the
 * actual mechanism lives in electron/apex-runtime-latest.cjs and the main.cjs
 * handlers. We only own UI state here:
 *   - the installed engine version (R6), read locally on About-panel open,
 *   - the last opt-in check result (installed + admin-latest) for R5,
 *   - in-flight flags for the check / apply buttons.
 *
 * Opt-in distinction: getVersion is a local, no-network marker read, safe to
 * call on panel open. checkUpdate/applyUpdate hit the network / change state and
 * only run when the user clicks (apply additionally requires a confirm).
 */

import { atom } from 'nanostores'

import type { DesktopRuntimeUpdateApply, DesktopRuntimeUpdateCheck, DesktopRuntimeVersion } from '@/global'

export const $runtimeVersion = atom<DesktopRuntimeVersion | null>(null)
export const $runtimeUpdateCheck = atom<DesktopRuntimeUpdateCheck | null>(null)
export const $runtimeUpdateChecking = atom<boolean>(false)
export const $runtimeUpdateApplying = atom<boolean>(false)

/**
 * Load the installed engine version (R6). Local marker read — no network, no
 * state change — so it's safe to call on About-panel open. Never throws; on a
 * missing bridge or read error it stores/returns an ok:false result with null
 * fields and the panel falls back to "version unavailable".
 */
export async function loadRuntimeVersion(): Promise<DesktopRuntimeVersion> {
  const bridge = window.hermesDesktop?.runtime
  const empty: DesktopRuntimeVersion = { ok: false, version: null, commit: null, branch: null, key: null }

  if (!bridge?.getVersion) {
    $runtimeVersion.set(empty)

    return empty
  }

  try {
    const result = await bridge.getVersion()
    $runtimeVersion.set(result)

    return result
  } catch {
    $runtimeVersion.set(empty)

    return empty
  }
}

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
