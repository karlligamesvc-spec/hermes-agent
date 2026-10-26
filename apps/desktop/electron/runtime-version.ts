import type { IpcMain } from 'electron'

import { engineMeetsMinVersion } from './apex-runtime-latest'
import { commitKeysMatch } from './bootstrap-runner'

interface PendingRuntimePreparationDependencies {
  isPackaged: boolean
  diagnostic: boolean
  explicitRoot?: string
  remote: boolean
  managedRestorePending: boolean
  waitForPendingStarts: () => Promise<void>
  waitForPackagedEngine: () => Promise<unknown>
}

/** Observe an existing local startup, including an opt-in legacy bootstrap. */
export async function waitForPendingRuntimePreparation(
  dependencies: PendingRuntimePreparationDependencies
): Promise<void> {
  if (
    !dependencies.isPackaged ||
    dependencies.diagnostic ||
    dependencies.explicitRoot ||
    dependencies.remote ||
    dependencies.managedRestorePending
  ) {
    return
  }

  // The start is tracked before it resolves its backend or enters the bundle gate.
  await dependencies.waitForPendingStarts()
  await dependencies.waitForPackagedEngine()
}

interface RuntimeMarker {
  pinnedCommit?: string | null
  pinnedBranch?: string | null
  version?: string | null
}

/** The installed marker already records this pin, and the pin's version has not moved since. */
export function markerMatchesPin(
  marker: RuntimeMarker | null | undefined,
  pin: { key?: unknown; version?: string | null }
): boolean {
  const installedKey = (marker && (marker.pinnedCommit || marker.pinnedBranch)) || null

  if (!installedKey || String(installedKey) !== String(pin.key)) {
    return false
  }

  return !(marker && marker.version && pin.version && marker.version !== pin.version)
}

interface RuntimeVersionDependencies {
  waitForRuntimePreparation: () => Promise<void>
  readMarker: () => RuntimeMarker | null
  readTreeCommit: () => string | null
  minEngineVersion: () => string | null
  updateDeferred?: () => boolean
  /** hc-1033: this boot kept an engine other than the shipped one (packagedEngineKeptBack). */
  keptBack?: () => Promise<{ reason: string; bundledVersion: string } | null>
  /** hc-1033: the shipped engine as a pin, or null where this build may not switch engines by itself. */
  bundledEnginePin?: () => { key: string; version: string } | null
  applyPin?: (pin: any) => Promise<unknown>
  log: (message: string) => void
}

export function registerRuntimeVersionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  dependencies: RuntimeVersionDependencies
): void {
  ipcMain.handle('hermes:runtime:version', async () => {
    try {
      // A read can arrive before the startup enters the packaged-engine gate.
      // Join already-tracked preparation before observing either marker or tree.
      await dependencies.waitForRuntimePreparation()
      const marker = dependencies.readMarker()
      const commit = marker?.pinnedCommit || null
      const branch = marker?.pinnedBranch || null
      const version = marker?.version || null
      const minEngineVersion = dependencies.minEngineVersion()
      const treeCommit = dependencies.readTreeCommit()

      return {
        ok: true,
        version,
        commit,
        branch,
        key: commit || branch || null,
        minEngineVersion,
        meetsMinEngine: engineMeetsMinVersion(version, minEngineVersion),
        treeCommit,
        updateDeferred: dependencies.updateDeferred?.() ?? false,
        keptBack: (await dependencies.keptBack?.()) ?? null,
        // A marker records the last target; the source stamp confirms its activation.
        treeMatchesMarker: treeCommit && commit ? commitKeysMatch(treeCommit, commit) : null
      }
    } catch (error: any) {
      dependencies.log(`[runtime-update] version read errored: ${error && error.message}`)

      return {
        ok: false,
        version: null,
        commit: null,
        branch: null,
        key: null,
        minEngineVersion: null,
        meetsMinEngine: true,
        treeCommit: null,
        treeMatchesMarker: null
      }
    }
  })

  // hc-1033: the kept-back notice's action. It reuses the opt-in apply: the pin is the shipped payload,
  // so apply arms the offline install as a confirmed source and the renderer's reload performs it.
  ipcMain.handle('hermes:runtime:switch-to-bundled-engine', async () => {
    try {
      const pin = dependencies.bundledEnginePin?.()

      if (!pin || !dependencies.applyPin) {return { ok: false, error: 'unsupported' }}
      dependencies.log(`[runtime-update] switching to the bundled engine on request: ${pin.version}`)

      return await dependencies.applyPin(pin)
    } catch (error: any) {
      dependencies.log(`[runtime-update] switch to the bundled engine failed: ${error && error.message}`)

      return { ok: false, error: (error && error.message) || String(error) }
    }
  })
}
