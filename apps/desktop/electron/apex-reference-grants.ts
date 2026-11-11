/**
 * apex-reference-grants.ts — a folder the user hands over reaches the agent (hc-1207).
 *
 * A folder outside the chat's working directory (for an assistant, its profile home) reached the
 * agent only as "path is outside the allowed workspace". The engine now grants such a folder to ONE
 * session (apex_overlay/folder_grants.py, RPC `folder.attach`), and only against a signature from
 * this module:
 *
 * - one random key per app launch, given to every engine this launch spawns
 *   (HERMES_DESKTOP_REFERENCE_GRANT_KEY). It is never written to disk, and the engine keeps it out of
 *   agent subprocesses.
 * - a ledger of the paths a trusted source handed over during this launch: the native open dialog's
 *   answer (`hermes:selectPaths`, recorded here in main), and the path preload's
 *   `webUtils.getPathForFile` read from a real dropped or pasted File (`hermes:noteHandedOverPaths`).
 *   Only preload sends that: under contextIsolation the page has no ipcRenderer, and a File the page
 *   builds itself has no path.
 * - `hermes:folderGrants` signs only ledger paths that are existing directories. The renderer may ask
 *   about any path; one it typed or made up gets nothing.
 *
 * Trust boundary: drop and paste paths are reported by the renderer process (its preload). Script in
 * the page cannot name a path there, but code that took over the renderer process itself could note
 * one, and such code can already drive the engine over its WebSocket.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const REFERENCE_GRANT_KEY_ENV = 'HERMES_DESKTOP_REFERENCE_GRANT_KEY'
// Domain-separates these signatures; apex_overlay/folder_grants.py signs the same bytes.
const GRANT_DOMAIN = 'apexnodes-desktop-folder-grant:v1'
// Paths kept per launch; the oldest goes first. A grant is asked for at send time, so this only bounds memory.
const LEDGER_CAP = 4096

export function signFolderGrant(key: Buffer, target: string): string {
  return crypto.createHmac('sha256', key).update(`${GRANT_DOMAIN}\0${target}`, 'utf8').digest('hex')
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function createReferenceGrants(key: Buffer = crypto.randomBytes(32)) {
  const handedOver = new Set<string>()

  return {
    /** Record paths a trusted source handed over (the dialog's answer, a dropped or pasted File's path). */
    note(paths: unknown) {
      for (const entry of Array.isArray(paths) ? paths : []) {
        if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
          continue
        }

        handedOver.delete(entry)
        handedOver.add(entry)

        if (handedOver.size > LEDGER_CAP) {
          handedOver.delete(handedOver.values().next().value as string)
        }
      }
    },
    /** `{path: grant}` for the asked paths that were handed over and are directories; nothing else. */
    grantsFor(paths: unknown): Record<string, string> {
      const grants: Record<string, string> = {}

      for (const entry of Array.isArray(paths) ? paths : []) {
        if (typeof entry === 'string' && handedOver.has(entry) && isDirectory(entry)) {
          grants[entry] = signFolderGrant(key, entry)
        }
      }

      return grants
    },
    /** For every engine this launch spawns. */
    spawnEnv: (): Record<string, string> => ({ [REFERENCE_GRANT_KEY_ENV]: key.toString('hex') })
  }
}

export type ReferenceGrants = ReturnType<typeof createReferenceGrants>

/** This launch's key and ledger. */
export const referenceGrants = createReferenceGrants()

interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface ReferenceGrantIpcDeps {
  dialog: { showOpenDialog: (window: any, options: any) => Promise<OpenDialogResult> }
  isWindows: boolean
  mainWindow: () => unknown
  /** wsl-path-bridge: a POSIX/WSL default path bridged to a form the Windows dialog can open. */
  resolvePickerDefaultPath: (target: string, distro: undefined, profile?: string) => null | string | undefined
}

interface ReferenceGrantIpcMain {
  handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => void
}

function pickerDefaultPath(options: any, deps: ReferenceGrantIpcDeps): string | undefined {
  if (!options?.defaultPath) {
    return undefined
  }

  try {
    // On a Windows host with a WSL backend the cwd may be a POSIX/WSL path;
    // bridge it to a UNC/drive form the native dialog can actually open.
    const bridged = deps.isWindows
      ? deps.resolvePickerDefaultPath(String(options.defaultPath), undefined, options?.profile)
      : String(options.defaultPath)

    return bridged ? path.resolve(bridged) : undefined
  } catch {
    return undefined
  }
}

/** The native open dialog (moved here from main.ts), the grant ledger's two inputs and its signer. */
export function registerReferenceGrantIpc(
  ipcMain: ReferenceGrantIpcMain,
  deps: ReferenceGrantIpcDeps,
  grants: ReferenceGrants = referenceGrants
) {
  ipcMain.handle('hermes:selectPaths', async (_event, options: any = {}) => {
    const properties = options?.directories ? ['openDirectory'] : ['openFile']

    if (options?.multiple !== false) {
      properties.push('multiSelections')
    }

    const result = await deps.dialog.showOpenDialog(deps.mainWindow(), {
      title: options?.title || 'Add context',
      defaultPath: pickerDefaultPath(options, deps),
      properties,
      filters: Array.isArray(options?.filters) ? options.filters : undefined
    })

    if (result.canceled) {
      return []
    }

    grants.note(result.filePaths)

    return result.filePaths
  })

  // Preload sends the path of each real dropped or pasted File; a <webview> guest is not the app.
  ipcMain.on('hermes:noteHandedOverPaths', (event, paths) => {
    if (event?.sender?.getType?.() === 'window') {
      grants.note(paths)
    }
  })

  ipcMain.handle('hermes:folderGrants', (_event, paths) => grants.grantsFor(paths))
}
