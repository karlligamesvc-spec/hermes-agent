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

interface RuntimeVersionDependencies {
  waitForRuntimePreparation: () => Promise<void>
  readMarker: () => { pinnedCommit?: string | null; pinnedBranch?: string | null; version?: string | null } | null
  readTreeCommit: () => string | null
  minEngineVersion: () => string | null
  updateDeferred?: () => boolean
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
}
